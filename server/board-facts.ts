import { createHash } from "node:crypto";
import { defineAgentTool, type PluginHandlerContext, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { factReplySettings, setFactAutoReply, type BoardFact } from "../shared/board-facts";
import type { Note, SessionRow } from "../shared/contract";
import { ConversationReader, type Evidence } from "./conversation";
import { discoverSessions } from "./discovery";
import { type Preferences, type PreferenceStore, isManagedCoordinator } from "./preferences";
import type { NoteStore } from "./notes";
import { isCurrentMembership, managedSessions } from "./session-links";

type Sdk = PluginHandlerContext["paseo"];
type Cycle = NonNullable<Preferences["factCycle"]>;
const ttl = 10 * 60 * 1000;
const stale = "The coordinator, project scope, evidence or digest authorization changed. Refresh the board.";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = z.string().min(1).max(256);
const queries: Record<BoardFact["kind"], RegExp> = {
  report: /^(?:(?:단순 )?(?:상태|진행 상황) (?:공유|보고)입니다[.。] (?:현재 )?(?:요청할 결정|결정하실 일|요청 사항)(?:은|이) 없습니다[.。]?|(?:status update|for information) only[.] no (?:action|decision) (?:is )?(?:requested|required|needed)[.]?)$/i,
  managed: /^(?:(?:이|현재) 세션(?:이|은) (?:보드의? ?)?관리 (?:프로젝트|대상)(?:에|으로) (?:연결|포함|등록)(?:되어? ?있(?:나요|습니까)|되었나요|됐나요|되어? ?있는지 확인해 주세요)|is this session (?:included in|linked to|managed by) (?:a managed project|the coordinator board))\s*[?.？。]?$/i,
  project: /^(?:이 (?:작업|세션)은 (?:어느|어떤) 프로젝트 소속(?:인가요|인가)|(?:이|현재) 세션의 (?:관리 |원래 |담당 |소속 )?프로젝트(?:가|는)? (?:무엇인가요|어디인가요|어디입니까|어디예요)|(?:이|현재) 세션(?:이|은) (?:어느|어떤) 프로젝트에 (?:속해 있나요|연결되어 있나요)|which project (?:manages this session|does this session belong to|is this session assigned to))\s*[?？]?$/i,
  status: /^(?:(?:이|현재) 세션의 (?:현재 |실행 )?상태(?:가|는)? (?:무엇인가요|어떤가요|어떻게 되나요)|what is (?:this session['’]s (?:current )?status|the (?:current )?status of this session))\s*[?？]?$/i,
};
export function verifiedBoardFact(row: SessionRow, evidence: Evidence, scope: Preferences, note?: Note) {
  if (evidence.lastInputIds?.some(id => scope.clarifications?.[id])) return null;
  if (evidence.laterInput || row.status !== "idle" || row.nativePending || row.detail.includes("오류") || row.id === scope.coordinator ||
      !isCurrentMembership(row, scope) || (note && note.kind !== "clear")) return null;
  const last = evidence.turns.at(-1);
  if (!last || last.role !== "assistant" || last.truncated || last.text.length > 180 || /[\r\n]/.test(last.text)) return null;
  if (note?.origin === "person" && note.evidenceId === evidence.id) return null;
  const text = last.text.trim().normalize("NFC");
  const kind = (Object.keys(queries) as BoardFact["kind"][]).find(key => queries[key].test(text));
  if (!kind) return null;
  if (Object.values(scope.decisionReceipts).some(receipt => receipt.sessionId === row.id &&
      (receipt.status === "pending" || receipt.evidenceId === evidence.id))) return null;
  const saved = scope.judgments[row.id];
  const judgment = saved?.projectId === row.projectId ? saved : undefined;
  // Facts handle standalone turns. A saved question from an earlier turn is still open.
  if (judgment && ((judgment.kind === "question" && judgment.evidenceId !== evidence.id) ||
      (judgment.openQuestions?.length ?? judgment.openQuestion))) return null;
  if (judgment?.evidenceId === evidence.id &&
      (judgment.kind !== "question" || judgment.text !== text || judgment.content?.needsInput || judgment.content?.recommendation || judgment.content?.options?.length ||
      (judgment.content?.question && judgment.content.question !== text))) return null;
  const sourceProjectId = row.sourceProjectId ?? row.projectId;
  // Only host identifiers enter the packet. User-provided project titles, paths and
  // arbitrary prose are not a safe reply source for another model.
  if (![row.projectId, sourceProjectId].every(value => /^[a-z0-9][a-z0-9._:-]{0,255}$/i.test(value)) ||
      sourceProjectId === "unassigned") return null;
  const en = /^[a-z]/i.test(text);
  const answers = {
    report: en ? "The session reported status without requesting a decision." : "세션이 사람의 결정을 요청하지 않고 진행 상황을 보고했습니다.",
    status: en ? "Observed Paseo session status: idle." : "Paseo에서 관측한 세션 상태는 대기 중입니다.",
    managed: en ? `Included in managed project ${row.projectId}.` : `보드의 관리 프로젝트 ${row.projectId}에 포함되어 있습니다.`,
    project: en ? `Managed project: ${row.projectId}. Original Paseo project: ${sourceProjectId}.` :
      `보드의 관리 프로젝트는 ${row.projectId}, Paseo의 원래 프로젝트는 ${sourceProjectId}입니다.`,
  };
  const sources = {
    report: "Paseo assistant turn + runtime status",
    status: "Paseo agents.list",
    managed: "Paseo agents.list + workspaces.list · Coordinator Board project scope",
    project: "Paseo agents.list + workspaces.list · Coordinator Board project scope",
  };
  return { kind, evidenceId: evidence.id, recipientId: row.id, projectId: row.projectId, sourceProjectId, answer: answers[kind], source: sources[kind] };
}
type Qualified = NonNullable<ReturnType<typeof verifiedBoardFact>>;
const packet = (fact: Qualified) =>
  JSON.stringify({ type:"coordinator-board.fact", authority:"information-only", evidenceId:fact.evidenceId, answer:fact.answer, source:fact.source });
const signature = (fact: Qualified) => hash([fact.recipientId, fact.projectId, fact.sourceProjectId, fact.evidenceId, fact.kind, fact.answer]);
function messageIdFor(key: string) {
  return [key.slice(0,8),key.slice(8,12),"4"+key.slice(13,16),"8"+key.slice(17,20),key.slice(20,32)].join("-");
}

export class BoardFacts {
  private active = new Map<string, Promise<string>>();
  constructor(private store: PreferenceStore, private notes: NoteStore, private reader: ConversationReader, private now = Date.now) {}

  register(server: PluginServerContext) {
    server.handle(factReplySettings, async () => ({ enabled: this.store.read().autoReplyToBoardFacts }));
    server.handle(setFactAutoReply, async ({enabled}) => {
      this.store.change(s => { s.autoReplyToBoardFacts = enabled; if (!enabled) delete s.factCycle; });
      return { ok: true as const };
    });
  }

  decorate(rows: SessionRow[], evidence: Map<string,Evidence>, notes: Record<string,Note>) {
    const scope = this.store.read();
    const newest = new Map<string, BoardFact>();
    const changes: Record<string,BoardFact> = {};
    for (const [signature,saved] of Object.entries(scope.factHistory)) {
      if (saved.delivery === "pending" || saved.delivery === "unconfirmed") {
        const receipts = evidence.get(saved.recipientId)?.deliveries;
        if (receipts?.some(r=>r.id === saved.messageId && r.sender === saved.senderId &&
            r.bodyHash === createHash("sha256").update(packet(saved)).digest("hex"))) {
          saved.delivery = "sent";
          changes[signature] = saved;
        }
      }
      const key = JSON.stringify([saved.recipientId, saved.projectId, saved.sourceProjectId]);
      if ((newest.get(key)?.recordedAt ?? "") <= saved.recordedAt) newest.set(key, saved);
    }
    for (const row of rows) {
      const observed = evidence.get(row.id);
      const fact = observed && verifiedBoardFact(row, observed, scope, notes[row.id]);
      if (!fact) {
        const last = newest.get(JSON.stringify([row.id,row.projectId,row.sourceProjectId ?? row.projectId]));
        if (last) row.boardFact = {...last,current:false};
        continue;
      }
      const key = signature(fact);
      const saved = scope.factHistory[key] ?? (changes[key] = {...fact, recordedAt:new Date(this.now()).toISOString(), delivery:"recorded"});
      row.boardFact = {...saved,current:true};
      row.lane = "idle";
      row.detail = fact.answer;
    }
    if (Object.keys(changes).length) this.store.change(s => Object.assign(s.factHistory, changes));
  }

  async prepareCycle(paseo: Sdk, coordinator: string, requestKey: string): Promise<string|null> {
    const scope = this.store.read();
    if (scope.coordinator !== coordinator || !scope.autoReplyToBoardFacts) return null;
    const cycleId = hash(["board-facts/cycle", coordinator, requestKey]);
    if (scope.factCycleKeys[cycleId]) return scope.factCycle?.id === cycleId && scope.factCycle.expires > this.now() ? cycleId : null;
    const raw = await discoverSessions(paseo);
    const rows = managedSessions(raw,scope);
    if (!raw.some(r=>r.id===coordinator) || !(rows.some(r=>r.id===coordinator) || isManagedCoordinator(scope,coordinator))) throw Error(stale);
    const candidates: Record<string,string> = {};
    const evidence = await this.reader.decorate(paseo,rows,scope);
    const latest = this.store.read();
    const notes = this.notes.visible(new Set(rows.map(r => r.id)));
    for (const row of rows) {
      const e = evidence.get(row.id);
      const fact = e && verifiedBoardFact(row, e, latest, notes[row.id]);
      if (!fact || fact.kind === "report") continue;
      const key = signature(fact);
      const delivery = latest.factHistory[key]?.delivery;
      if (!delivery || delivery === "recorded") candidates[row.id] = key;
    }
    let result: string|null = null;
    this.store.change(s => {
      if (!s.autoReplyToBoardFacts || s.coordinator !== coordinator) return;
      if (s.factCycleKeys[cycleId]) {
        if (s.factCycle?.id === cycleId && s.factCycle.expires > this.now()) result = cycleId;
        return;
      }
      if (s.factCycle?.id !== scope.factCycle?.id) throw Error(stale);
      s.factCycleKeys[cycleId] = true;
      delete s.factCycle;
      if (Object.keys(candidates).length) {
        s.factCycle = { id:cycleId, coordinator, expires:this.now()+ttl, candidates };
        result = cycleId;
      }
    });
    return result;
  }

  bindMessage(coordinator: string, cycleId: string, messageId: string) {
    this.store.change(s => {
      const cycle = this.authorized(s, coordinator, cycleId);
      if (cycle.messageId && cycle.messageId !== messageId) throw Error(stale);
      cycle.messageId = messageId;
    });
  }

  private authorized(s: Preferences, caller: string, id: string): Cycle {
    const cycle = s.factCycle;
    if (!s.autoReplyToBoardFacts || !cycle || cycle.id !== id || cycle.coordinator !== caller ||
        s.coordinator !== caller || cycle.expires <= this.now()) throw Error(stale);
    return cycle;
  }

  readonly tool = defineAgentTool({
    name: "answer_board_fact",
    description: "During a newly authorized digest cycle, deliver a verified answer about the worker's own managed membership, project or observed runtime state. Use the actual cycleId and the worker's current evidenceId. The server generates the informational answer. Never use this to approve, choose, spend, publish, delegate or complete work.",
    input: z.strictObject({ cycleId: z.string().length(64), sessionId: id, evidenceId: z.string().min(1).max(64) }),
    execute: async (input, {paseo,agent}) => {
      const cycle = this.authorized(this.store.read(),agent.id,input.cycleId);
      const key = cycle.candidates[input.sessionId];
      if (!key || !cycle.messageId || input.sessionId === agent.id) throw Error(stale);
      const operationKey = hash([key,agent.id,input.cycleId,input.evidenceId]);
      let pending = this.active.get(operationKey);
      if (!pending) {
        pending = this.deliver(paseo,agent.id,cycle,input.sessionId,input.evidenceId,key).finally(() => this.active.delete(operationKey));
        this.active.set(operationKey,pending);
      }
      return {text:await pending};
    },
  });

  private async deliver(paseo: Sdk, caller: string, cycle: Cycle, target: string, evidenceId: string, key: string) {
    const raw = await discoverSessions(paseo);
    const scope = this.store.read();
    this.authorized(scope,caller,cycle.id);
    const managed = managedSessions(raw,scope);
    if (!(managed.some(r=>r.id===caller) || (isManagedCoordinator(scope,caller) && raw.some(r=>r.id===caller)))) throw Error(stale);
    const row = managed.find(r=>r.id===target);
    if (!row || row.nativePending || row.status !== "idle") throw Error(stale);
    const previous = scope.factHistory[key];
    if (previous && previous.evidenceId !== evidenceId) throw Error(stale);
    if (previous?.delivery === "sent") return "This verified answer was already accepted by Paseo.";
    if (previous && previous.delivery !== "recorded") throw Error("The prior delivery is unconfirmed. Check the recipient session before sending anything else.");
    const observed = await this.reader.read(paseo,row,true);
    const recipient = paseo.agents.ref(target);
    const live = (await recipient.refresh())?.agent;
    if (!observed || observed.id !== evidenceId || !live || live.id !== target || live.internal || live.archivedAt ||
        live.activeTurn || live.pendingPermissions.length || live.status !== "idle" || live.attentionReason === "permission" || live.updatedAt !== row.activityAt) throw Error(stale);
    const coordinatorTimeline = await paseo.agents.ref(caller).timeline.refetch({direction:"tail",projection:"projected",limit:128});
    const last = coordinatorTimeline.entries.findLast(({item})=>item.type === "user_message" ||
      (item.type === "tool_call" && (item.agentMessage || item.name === "heartbeat")))?.item;
    if (coordinatorTimeline.error || coordinatorTimeline.gap || coordinatorTimeline.staleCursor || last?.type !== "user_message" ||
        !(last.clientMessageId === cycle.messageId || last.messageId === cycle.messageId)) throw Error(stale);
    const note = this.notes.visible(new Set([target]))[target];
    const fact = verifiedBoardFact(row,observed,this.store.read(),note);
    if (!fact || fact.kind === "report" || signature(fact) !== key) throw Error(stale);
    const messageId = messageIdFor(hash(["board-facts/answer",caller,key]));
    const body = packet(fact);
    this.store.change(s => {
      const authorized = this.authorized(s,caller,cycle.id);
      if (authorized.messageId !== cycle.messageId || authorized.candidates[target] !== key ||
          !isCurrentMembership(row,s) || (s.factHistory[key] && s.factHistory[key].delivery !== "recorded")) throw Error(stale);
      s.factHistory[key] = {...fact, recordedAt:previous?.recordedAt ?? new Date(this.now()).toISOString(), delivery:"pending", senderId:caller,messageId};
    });
    try {
      // The installed SDK rejects a host lacking agent-message provenance. Never fall back to an unsigned user prompt.
      await recipient.send(body,{sourceAgentId:caller,messageId,activeTurnBehavior:"steer"});
    } catch {
      this.store.change(s=>{ if(s.factHistory[key]?.messageId===messageId) s.factHistory[key].delivery="unconfirmed"; });
      throw Error("Paseo did not confirm the sourced delivery. No unsigned message or automatic retry was sent.");
    }
    this.store.change(s=>{ if(s.factHistory[key]?.messageId===messageId) s.factHistory[key].delivery="sent"; });
    return "Paseo accepted the informational answer for the worker from the coordinator.";
  }
}
