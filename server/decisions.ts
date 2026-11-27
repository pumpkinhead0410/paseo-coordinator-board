import { restoreClarifiedDecision } from "./clarifications";
import { join } from "node:path";
import { SessionPhotoStore } from "./session-photos";
import { describePhotos, photoReceiptId } from "./reply-photos";
import { sessionReplyMessage } from "./decision-message";
import { createHash } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { Decision, DecisionInput } from "../shared/decision-actions";
import type { Note, SessionRow } from "../shared/contract";
import { classify, ConversationReader, lastConversationQuestion, type Evidence } from "./conversation";
import { isCurrentMembership, managedSessions } from "./session-links";
import { canReceiveBoardInput, discoverSessions } from "./discovery";
import type { NoteStore } from "./notes";
import { verifiedBoardFact } from "./board-facts";
import { isManagedCoordinator, type Preferences, type PreferenceStore } from "./preferences";

type Sdk = PluginHandlerContext["paseo"];
type Receipt = { ok: true; recipientId: string; messageId: string };
const changed = "결정 카드 또는 수신자가 바뀌었습니다. 보드를 새로 고쳐 주세요.";
const blocked = "이 세션의 현재 상태에서는 보낼 수 없습니다. 원래 세션에서 권한 요청과 작업 상태를 확인하세요.";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function isSupersededAgentNote(
  row: Pick<SessionRow, "id" | "projectId" | "evidenceId">,
  note: Note | undefined,
  prefs: Pick<Preferences, "judgments"> & Partial<Pick<Preferences, "supersededAgentNotes">>,
) {
  if (note?.origin !== "agent" || note.kind === "clear" || !note.evidenceId) {
    return false;
  }
  const superseded = prefs.supersededAgentNotes?.[row.id];
  if (
    superseded?.projectId === row.projectId &&
    superseded.revision === note.revision &&
    superseded.evidenceId === note.evidenceId &&
    (!row.evidenceId || row.evidenceId !== note.evidenceId)
  ) {
    return true;
  }
  const judgment = prefs.judgments[row.id];
  return (
    judgment?.projectId === row.projectId &&
    judgment.kind === "idle" &&
    !!row.evidenceId &&
    row.evidenceId !== note.evidenceId &&
    judgment.evidenceId === row.evidenceId
  );
}

export function decorateDecision(row: SessionRow, note: Note | undefined, prefs: Preferences, evidence?: Evidence) {
  const answer = prefs.answers[row.id];
  const supersededAgentNote = isSupersededAgentNote(row, note, prefs);
  if (supersededAgentNote) row.agentNoteSuperseded = true;
  else delete row.agentNoteSuperseded;
  const activeNote = supersededAgentNote ? undefined : note;
  const noteQuestion = activeNote?.kind === "question";
  const answeredNote = noteQuestion && answer?.noteRevision === activeNote.revision;
  const dismissed = row.evidenceId && row.evidenceId === activeNote?.evidenceId && activeNote.origin === "person" && activeNote.kind !== "question";
  const judgment = prefs.judgments[row.id];
  const matched = judgment?.projectId === row.projectId ? judgment : undefined;
  const currentQuestion = matched?.kind === "question" ? matched : undefined;
  const structured = currentQuestion?.evidenceId === row.evidenceId ? currentQuestion : undefined;
  const pending = matched?.openQuestions ?? (matched?.openQuestion ? [matched.openQuestion] : []);
  const carried = currentQuestion
    ? (structured ? undefined : { ...currentQuestion, question: currentQuestion.content?.question })
    : pending.at(-1);
  let content: Omit<Decision, "version">;
  let questionEvidenceId: string | undefined;
  if (row.nativePending) {
    content = { source: "permission", question: row.detail };
  } else if (carried?.text && row.status === "idle" && row.evidenceId && !dismissed && !row.boardFact?.current) {
    content = { ...carried.content, source: "coordinator", question: carried.question ?? carried.text };
    questionEvidenceId = carried.evidenceId;
    // A newly detected question remains visible as evidence until it is classified.
    if (row.lane !== "human") row.detail = "코디네이터 판단 · " + content.question;
    row.lane = "human";
    row.decisionRequestedAt = carried.requestedAt;
  } else if (row.status === "idle" && row.evidenceId && !dismissed && row.lane === "human") {
    content = structured
      ? { ...structured.content, source: "coordinator", question: structured.content?.question || structured.text }
      : { source: "conversation", question: row.detail.replace(/^세션의 확인 요청 · /, "") };
  } else if (noteQuestion && !answeredNote && row.status === "idle" && row.evidenceId) {
    content = { source: activeNote.origin === "agent" ? "agent-note" : "person-note", question: activeNote.text };
  } else {
    if (answeredNote && !row.nativePending) row.decisionAnswered = true;
    return;
  }
  const version = hash([row.projectId, row.id, row.nativePending ? row.permissionVersion : questionEvidenceId ?? row.evidenceId, activeNote?.revision ?? 0, content]);
  if (content.source !== "permission" && answer?.version === version) {
    row.decisionAnswered = true;
    row.lane = "review";
    row.detail = "답장을 보냈습니다. 담당 세션의 결과를 기다립니다.";
  } else {
    row.decision = { ...content, version, ...(questionEvidenceId ? {evidenceId: questionEvidenceId} : {}) };
    if (content.source === "conversation" && evidence) {
      const excerpt = lastConversationQuestion(evidence, row.id === prefs.coordinator);
      if (excerpt?.question === content.question && excerpt.markdown !== content.question) {
        row.decision.questionMarkdown = excerpt.markdown;
      }
    }
  }
}

function requireScope(scope: Preferences, input: DecisionInput) {
  const recipient = input.action === "coordinate" ? scope.coordinator : input.sessionId;
  if (!scope.projects.includes(input.projectId) || !recipient || recipient !== input.recipientId) throw Error(changed);
}

function messageUuid(key: string) {
  const h = hash(["coordinator-board/decision", key]);
  return [h.slice(0, 8), h.slice(8, 12), "4" + h.slice(13, 16), "8" + h.slice(17, 20), h.slice(20, 32)].join("-");
}

export class DecisionSender {
  private active = new Map<string, { fingerprint: string; result: Promise<Receipt> }>();
  private sendingCards = new Set<string>();
  private sessionPhotos: SessionPhotoStore;
  constructor(private store: PreferenceStore, private notes: NoteStore, private reader: ConversationReader) {
    this.sessionPhotos = new SessionPhotoStore(join(store.directory, "session-photos"));
  }

  send(paseo: Sdk, input: DecisionInput): Promise<Receipt> {
    const messageId = messageUuid(input.requestKey);
    const photos = describePhotos(input.images);
    const content = [input.projectId, input.sessionId, input.recipientId, input.version, input.action, input.text];
    // Keep text-only keys compatible with receipts written before photo support.
    const fingerprint = hash(photos.length ? [...content, photos] : content);
    const running = this.active.get(messageId);
    if (running) {
      if (running.fingerprint === fingerprint) return running.result;
      return Promise.reject(Error("같은 전송 키로 다른 답을 보낼 수 없습니다."));
    }
    if (this.sendingCards.has(input.sessionId)) return Promise.reject(Error("이 카드의 이전 전송을 확인하고 있습니다."));
    this.sendingCards.add(input.sessionId);
    const result = this.deliver(paseo, input, messageId, fingerprint).finally(() => {
      this.active.delete(messageId);
      this.sendingCards.delete(input.sessionId);
    });
    this.active.set(messageId, { fingerprint, result });
    return result;
  }

  private async deliver(paseo: Sdk, input: DecisionInput, messageId: string, fingerprint: string): Promise<Receipt> {
    const scope = this.store.read();
    requireScope(scope, input);
    messageId = photoReceiptId(messageId, !!input.images?.length, scope.decisionReceipts);
    const requestId = messageId;
    let earlier = scope.decisionReceipts[messageId];
    if (!earlier) {
      const previous = Object.entries(scope.decisionReceipts).find(([, saved]) =>
        saved.sessionId === input.sessionId && saved.version === input.version &&
        (saved.fingerprint === fingerprint || saved.status === "pending"));
      if (previous) {
        [messageId, earlier] = previous;
        if (earlier.fingerprint !== fingerprint) throw Error("이 카드의 이전 전송 결과를 수신 세션에서 먼저 확인해 주세요.");
      }
    }
    messageId = earlier?.messageId ?? messageId;
    const receipt: Receipt = { ok: true, recipientId: input.recipientId, messageId };
    const recipient = paseo.agents.ref(input.recipientId);
    const rows = await discoverSessions(paseo);
    const managed = managedSessions(rows, this.store.read());
    const row = managed.find(r => r.id === input.sessionId && r.projectId === input.projectId);
    const destination = managed.find(r => r.id === input.recipientId) ??
      (isManagedCoordinator(scope, input.recipientId) ? rows.find(r => r.id === input.recipientId) : undefined);
    if (!row || !destination) throw Error(changed);
    if (earlier) {
      if (earlier.fingerprint !== fingerprint) throw Error("같은 전송 키로 다른 답을 보낼 수 없습니다.");
      if (earlier.status === "sent") {
        if (requestId !== messageId && !scope.decisionReceipts[requestId]) {
          this.store.change(current => { current.decisionReceipts[requestId] = { ...current.decisionReceipts[messageId], messageId }; });
        }
        return receipt;
      }
      // A worker can restart after the daemon accepted a message but before the receipt was saved.
      const page = await recipient.timeline.refetch({ direction: "tail", projection: "projected", limit: 128 });
      const latestScope = this.store.read();
      requireScope(latestScope, input);
      if (!isCurrentMembership(row, latestScope) || (!isCurrentMembership(destination, latestScope) && !isManagedCoordinator(latestScope, destination.id))) throw Error(changed);
      const accepted = !page.error && !page.gap && !page.staleCursor && page.entries.some(({ item }) =>
        item.type === "user_message" && (item.clientMessageId === messageId || item.messageId === messageId) &&
        (earlier.messageHash ? hash(item.text) === earlier.messageHash : item.text === input.text));
      if (!accepted) throw Error("이전 전송 결과를 확인하지 못했습니다. 수신 세션에서 확인해 주세요.");
      this.finish(input, messageId, requestId);
      return receipt;
    }

    if (row.nativePending || row.status !== "idle") throw Error(blocked);
    requireScope(this.store.read(), input);
    const evidence = await this.reader.read(paseo, row, true);
    if (!evidence) throw Error(changed);
    const latest = await Promise.all([...new Set([input.sessionId, input.recipientId])].map(async id => ({
      id, agent: (await paseo.agents.ref(id).refresh())?.agent,
    })));
    for (const { id, agent } of latest) {
      if (!agent || agent.id !== id || agent.internal || agent.archivedAt || !canReceiveBoardInput(agent,input.action==="coordinate" && id===input.recipientId && id!==input.sessionId)) throw Error(blocked);
      if (id === input.sessionId && row.activityAt !== agent.updatedAt) throw Error(changed);
    }
    const note = this.notes.visible(new Set([row.id]))[row.id];
    let text = "";
    this.store.change(current => {
      requireScope(current, input);
      if (!isCurrentMembership(row, current) || (!isCurrentMembership(destination, current) && !isManagedCoordinator(current, destination.id))) throw Error(changed);
      const judgment = current.judgments[row.id];
      if (verifiedBoardFact(row, evidence, current, note)) throw Error(changed);
      Object.assign(row, classify(evidence, row, judgment?.projectId === row.projectId ? judgment : undefined, row.id === current.coordinator), { evidenceId: evidence.id });
      decorateDecision(row, note, current, evidence);
      restoreClarifiedDecision(row, note, current, evidence);
      if (!row.decision || row.decision.source === "permission" || row.decision.version !== input.version) throw Error(changed);
      text = sessionReplyMessage(row,input);
      if (input.images?.length) this.sessionPhotos.save(input.recipientId, messageId, input.images);
      current.decisionReceipts[messageId] = {
        ...(input.images?.length ? {messageId} : {}),
        messageHash:hash(text),
        activity: { origin:{sessionId:row.id, cardId:row.id, revision:input.version, questions:[{id:input.version}]},
          title: row.decision.question || row.title, at: new Date().toISOString(), projectId: input.projectId,
          ...(input.images?.length ? {imageCount:input.images.length} : {}),
          answer: input.text, recipientId: input.recipientId, coordinator: input.action === "coordinate" },
        fingerprint, sessionId: row.id, version: input.version, evidenceId: evidence.id, status: "pending", beforeAnswer: current.answers[row.id]?.version,
        ...(note?.kind === "question" && (row.decision.source === "agent-note" || row.decision.source === "person-note") ? { noteRevision: note.revision } : {}),
      };
    });
    try {
      await recipient.send(text, { messageId, activeTurnBehavior: "steer", ...(input.images?.length ? {images:input.images} : {}) });
    } catch {
      throw Error("전송 결과를 확인하지 못했습니다. 같은 요청을 다시 확인하거나 수신 세션을 열어 주세요.");
    }
    this.finish(input, messageId);
    return receipt;
  }

  private finish(input: DecisionInput, messageId: string, requestId = messageId) {
    this.store.change(current => {
      const delivery = current.decisionReceipts[messageId];
      delivery.status = "sent";
      if (requestId !== messageId) current.decisionReceipts[requestId] = { ...delivery, messageId };
      if (input.action === "reply" && current.projects.includes(input.projectId) && current.answers[input.sessionId]?.version === delivery.beforeAnswer) {
        current.answers[input.sessionId] = { version: input.version, noteRevision: delivery.noteRevision };
      }
    });
  }
}
