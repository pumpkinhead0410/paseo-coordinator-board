import { quotaEvidence } from "./quota-notice";
import { createHash } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { SessionRow } from "../shared/contract";
import type { Preferences } from "./preferences";

type Sdk = PluginHandlerContext["paseo"];
type Page = Awaited<ReturnType<ReturnType<Sdk["agents"]["ref"]>["timeline"]["refetch"]>>;
export type Turn = { role: "user" | "assistant"; text: string; truncated?: boolean; at?: string; replyId?: string };
type ClarificationObservation = { bodyHash: string; response?: string };
export type Evidence = {
  quota?: ReturnType<typeof quotaEvidence>;
  id: string; turns: Turn[];
  cursor?: string;
  userReplies?: Turn[];
  replyResponses?: Map<string, Turn[]>;
  evidencePositions?: Map<string, string>;
  replies?: Map<string, string>;
  lastInputIds?: string[];
  boardMessageHashes?: Map<string,string>;
  clarificationMessages?: Map<string, ClarificationObservation>;
  laterInput?: boolean;
  deliveries?: { id: string; sender: string; bodyHash: string }[];
};
type Candidate = Pick<SessionRow, "lane" | "detail" | "decisionRequestedAt">;
export function followsCursor(position: string | undefined, cursor: string | undefined): boolean {
  if (!position || !cursor) return false;
  const [epoch, seq] = position.split(":");
  const [earlierEpoch, earlierSeq] = cursor.split(":");
  return epoch === earlierEpoch && Number(seq) > Number(earlierSeq);
}

const request = /확인해\s*주실\s*것|(?:확인|선택|승인|결정|답변|지정)\s*(?:부탁드|해\s*(?:주세|주실|주셔야|주시겠))|(?:알려|골라|정해|답해)\s*(?:주세|주실|주셔야)|(?:할까요|될까요|하시겠어요|고르시겠어요|원하시나요)[?？]|\b(?:please (?:choose|confirm|approve)|which .* (?:prefer|choose)|shall I|would you like me to|could you (?:confirm|choose))\b/i;
const optionalOffer = /(?:궁금|필요|원하).{0,12}(?:시면|시다면|면).{0,25}(?:알려|말씀|도와)|\b(?:if you (?:like|want)|let me know if)\b/i;

export function excerpt(page: Page): Evidence {
  if (page.error || page.gap || page.staleCursor) throw new Error("대화 발췌를 확인할 수 없습니다.");
  const turns: Turn[] = [];
  const digest = createHash("sha256").update(page.epoch);
  const epoch = createHash("sha256").update(page.epoch).digest("hex").slice(0, 24);
  const position = (seq: number) => epoch + ":" + seq;
  const userReplies: Turn[] = [];
  const replyResponses = new Map<string, Turn[]>();
  const evidencePositions = new Map<string, string>();
  const laterInputs: string[] = [];
  const deliveries: NonNullable<Evidence["deliveries"]> = [];
  const replies = new Map<string, string>();
  const boardMessageHashes=new Map<string,string>();
  let messageIds: string[] = [];
  let clarification: ClarificationObservation | undefined;
  let responseTurns: Turn[] | undefined;
  const clarificationMessages = new Map<string, ClarificationObservation>();
  for (const { item, seqEnd, timestamp } of page.entries) {
    if (item.type === "tool_call" && (item.agentMessage || item.name === "heartbeat")) {
      messageIds = [];
      clarification = undefined;
      responseTurns = undefined;
      laterInputs.push(item.callId);
      const prefix = "paseo-agent-message:";
      if (item.status === "completed" && item.callId.startsWith(prefix) && item.agentMessage?.event === "message") {
        deliveries.push({ id:item.callId.slice(prefix.length), sender:item.agentMessage.sender.id,
          bodyHash:createHash("sha256").update(item.agentMessage.text).digest("hex") });
      }
    }
    if (item.type !== "assistant_message" && item.type !== "user_message") continue;
    const role = item.type === "assistant_message" ? "assistant" : "user";
    const text = item.text.trim();
    if (item.type === "user_message") {
      responseTurns = undefined;
      messageIds = [item.messageId, item.clientMessageId].filter((id): id is string => !!id);
      if (messageIds.length && text.startsWith("[Coordinator Board · ")) {
        const hash=createHash("sha256").update(item.text).digest("hex");
        for (const id of messageIds) boardMessageHashes.set(id,hash);
      }
      clarification = text.startsWith("[Coordinator Board · 추가 질문]")
        ? { bodyHash: createHash("sha256").update(item.text).digest("hex") } : undefined;
      if (clarification) {
        for (const id of messageIds) clarificationMessages.set(id, clarification);
      }
    } else if (text) {
      if (clarification) clarification.response = text.slice(0, 16000);
      for (const id of messageIds) replies.set(id, text.length > 1200 ? text.slice(0, 1199) + "…" : text);
    }
    if (!text) continue;
    laterInputs.length = 0;
    const turn: Turn = { role, ...(role === "user" && !clarification ? {replyId: position(seqEnd)} : {}), text: text.slice(-2000), ...(timestamp ? { at:timestamp } : {}), ...(text.length > 2000 ? { truncated: true } : {}) };
    turns.push(turn);
    if (turn.replyId) {
      userReplies.push(turn);
      responseTurns = [];
      replyResponses.set(turn.replyId, responseTurns);
    } else if (turn.role === "assistant") responseTurns?.push(turn);
    digest.update(JSON.stringify([seqEnd, role, text]));
    evidencePositions.set(digest.copy().digest("hex").slice(0, 24), position(seqEnd));
  }
  if (laterInputs.length) digest.update(JSON.stringify(laterInputs));
  const quota = quotaEvidence(page);
  return { ...(quota ? {quota} : {}), id: digest.digest("hex").slice(0, 24), turns: turns.slice(-4),
    cursor: position(page.entries.at(-1)?.seqEnd ?? 0), userReplies, replyResponses, evidencePositions,
    ...(clarification && messageIds.length ? { lastInputIds: messageIds } : {}),
    ...(clarificationMessages.size ? { clarificationMessages } : {}),
    ...(boardMessageHashes.size ? {boardMessageHashes} : {}),
    ...(replies.size ? { replies } : {}), ...(laterInputs.length ? {laterInput:true} : {}), ...(deliveries.length ? {deliveries} : {}) };
}

const noQuestion = /(?:확인해\s*주실\s*것|결정해\s*주실\s*것|확인\s*요청)(?:은|이|이란)?\s*(?:없|없습니다|없음)/;

function questionIn(text: string, coordinatorDigest = false) {
  const original = text.split("\n");
  // Keep the source line indexes when ignoring code examples during question detection.
  const lines = text.replace(/^`{3}[\s\S]*?^`{3}[^\n]*/gm, block => block.replace(/[^\n]/g, ""))
    .split("\n").map(line => line.trim());
  // A coordinator's digest quotes questions belonging to other sessions in typed table rows.
  const quotedRow = (line: string) => coordinatorDigest && /^\|[^|]+\|\s*(?:question|질문)\s*(?:\+[^|]*)?\|/i.test(line);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (quotedRow(lines[i]) || lines[i].startsWith(">") || noQuestion.test(lines[i]) || optionalOffer.test(lines[i]) || !request.test(lines[i])) continue;
    // Include the checklist or options after a request heading.
    const included = (line: string) => !line.startsWith(">") && !quotedRow(line);
    return {
      // Existing replies and ledger matches identify this question by its compact text.
      question: lines.slice(i).filter(line => line && included(line)).join(" ").slice(0, 340),
      markdown: original.slice(i).filter((_, index) => included(lines[i + index])).join("\n").trimEnd(),
    };
  }
  return null;
}

export function lastConversationQuestion(evidence: Evidence, coordinatorDigest = false) {
  const last = evidence.turns.at(-1);
  return last?.role === "assistant" ? questionIn(last.text, coordinatorDigest) : null;
}

export function classify(e: Evidence, row: SessionRow, decision?: Preferences["judgments"][string], isCoordinator = false): Candidate {
  if (row.lane === "human" || row.lane === "running" || row.lane === "unknown" || row.detail.includes("오류")) return row;
  const last = e.turns.at(-1);
  if (decision?.evidenceId === e.id) {
    const askedAt = decision.kind === "question" && (last?.role === "assistant" && questionIn(last.text, isCoordinator) ? last.at ?? decision.requestedAt : decision.requestedAt);
    return { lane: decision.kind === "question" ? "human" : decision.kind, detail: "코디네이터 판단 · " + decision.text,
      ...(askedAt ? {decisionRequestedAt:askedAt} : {}) };
  }
  if (!last) return row;
  if (last.role === "assistant") {
    const question = questionIn(last.text, isCoordinator);
    if (question) return { lane: "human", detail: "세션의 확인 요청 · " + question.question, ...(last.at ? {decisionRequestedAt:last.at} : {}) };
  } else {
    const previous = e.turns.slice(0, -1).findLast(t => t.role === "assistant");
    if (previous && questionIn(previous.text, isCoordinator)) {
      return { lane: "review", detail: "질문 뒤에 메시지가 왔습니다. 같은 질문에 대한 답인지 확인하세요." };
    }
  }
  return row;
}

export class ConversationReader {
  private readonly cache = new Map<string, { stamp: string; at: number; page: Promise<Evidence> }>();

  retain(ids: Set<string>) {
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
  }

  async read(paseo: Sdk, row: SessionRow, fresh = false): Promise<Evidence | null> {
    const cached = this.cache.get(row.id);
    if (row.status === "closed") {
      return cached?.stamp === row.activityAt ? cached?.page ?? null : null;
    }
    if (row.status !== "idle" && row.status !== "error") return null;
    if (!fresh && cached && cached.stamp === row.activityAt && Date.now() - cached.at < 60_000) return cached.page;
    const page = paseo.agents.ref(row.id).timeline.refetch({ direction: "tail", projection: "projected", limit: 48 }).then(excerpt);
    this.cache.set(row.id, { stamp: row.activityAt ?? "", at: Date.now(), page });
    try { return await page; }
    catch (error) {
      if (this.cache.get(row.id)?.page === page) this.cache.delete(row.id);
      throw error;
    }
  }

  async decorate(paseo: Sdk, rows: SessionRow[], prefs: Preferences) {
    this.retain(new Set([...rows.map(row => row.id), ...(prefs.coordinator ? [prefs.coordinator] : [])]));
    const observed = new Map<string, Evidence>();
    let cursor = 0;
    const work = async () => {
      while (cursor < rows.length) {
        const row = rows[cursor++];
        try {
          const evidence = await this.read(paseo, row);
          if (evidence && row.lane !== "human" && (row.lane === "idle" || row.lane === "review") && !row.detail.includes("오류")) {
            observed.set(row.id, evidence);
            const judgment = prefs.judgments[row.id];
            Object.assign(row, classify(evidence, row, judgment?.projectId === row.projectId ? judgment : undefined, row.id === prefs.coordinator), { evidenceId: evidence.id });
          }
        } catch {
          row.detail += " · 최근 대화 조회 실패";
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, work));
    return observed;
  }
}
