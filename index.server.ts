import { claimQuotaNotice } from "./server/quota-notice";
import type { ReplyEntry } from "./shared/reply-history";
import { trackedRecipient, usesSourceCoordinator } from "./shared/tracked-decisions";
import { boardReadiness } from "./shared/readiness";
import { SnapshotReads } from "./server/snapshot-reads";
import { readProjectDecisionSources } from "./server/project-decision-sources";
import { TrackedDecisionStore } from "./server/tracked-decisions";
import { MergeNotifications } from "./server/merge-notifications";
import { ProjectPullRequests } from "./server/prs";
import { decisionCount } from "./shared/decision-count";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import { boardDecisionCount, claimBoardQuotaNotice, boardScope, boardSnapshot, reportingKey, saveNote, setReporting } from "./shared/contract";
import { canReceiveBoardInput, discoverSessions } from "./server/discovery";
import { attachReportTool } from "./server/reporting";
import { ConversationReader, excerpt } from "./server/conversation";
import { isManagedCoordinator, setCoordinator, PreferenceStore } from "./server/preferences";
import { trackedReviewTool } from "./server/tracked-review";
import { attachCoordinatorTools } from "./server/coordinator";
import { createOperations } from "./server/operations";
import { hostVisibility } from "./shared/hosts";
import { decorateDecision, DecisionSender } from "./server/decisions";
import { sendDecision } from "./shared/decision-actions";
import { isCurrentMembership, managedSessions, registerSessionLinks, releaseUnmanagedCoordinator } from "./server/session-links";
import { registerRecommendation } from "./server/recommendation";
import { NoteStore } from "./server/notes";
import { askClarification, sourceQuestion } from "./shared/clarifications";
import { ClarificationSender, clarificationHistory, restoreClarifiedDecision } from "./server/clarifications";
import { BoardFacts } from "./server/board-facts";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(hostVisibility);
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const dataDir = join(home, "plugin-data", "coordinator-board");
  const notes = new NoteStore(join(dataDir, "notes.json"));

  const prefs = new PreferenceStore(join(dataDir, "scope.json"));
  const reader = new ConversationReader();
  server.handle(claimBoardQuotaNotice, async (_input, { paseo }) => ({
    message: await claimQuotaNotice(paseo, prefs, notes, reader),
  }));
  const facts = new BoardFacts(prefs, notes, reader);
  facts.register(server);
  const operations = createOperations(prefs, join(home, "plugin-workspaces", "coordinator-board"), facts);
  operations.register(server);
  registerSessionLinks(server, prefs);
  const decisions = new DecisionSender(prefs, notes, reader);
  registerRecommendation(server, decisions);
  server.handle(sendDecision, async (input, { paseo }) => {
    const result = await decisions.send(paseo, input);
    invalidateCount();
    return result;
  });
  const prs = new ProjectPullRequests(prefs);
  const tracked = new TrackedDecisionStore(join(dataDir, "tracked-decisions.json"),
    selected => {
      let partial = false;
      const items = readProjectDecisionSources(join(dataDir, "tracked-sources.json"), selected, () => { partial = true; });
      return {items,partial};
    });
  const mergeNotifications = new MergeNotifications(prefs,(target,coordinator)=>tracked.mergeRecipient(target,coordinator),
    (sdk,target)=>prs.mergeScope(sdk,target));
  server.handle(boardReadiness, async () => {
    const scope = prefs.read();
    return { configured: scope.projects.length > 0, coordinator: scope.coordinator, decisionTitles: tracked.previewTitles(new Set(scope.projects)) };
  });
  async function buildSnapshot(paseo: PluginHandlerContext["paseo"], refreshPulls=false) {
    // GitHub can take seconds even when Paseo already knows the current sessions.
    // Start both paths together, and consume both rejections via Promise.all.
    const catalogRead = paseo.projects.list();
    const [sessionView, fetched] = await Promise.all([
      (async () => {
        const [catalog, rows] = await Promise.all([catalogRead, discoverSessions(paseo)]);
        return buildSessionView(paseo, catalog, rows);
      })(),
      catalogRead.then(({ projects }) => prs.read(paseo, { projects, refresh:refreshPulls })),
    ]);
    const { choices, sessions, evidence, coordinatorRow } = sessionView;
    const latest = prefs.read();
    // Loading the board should not wait on an idle check or a provider turn.
    if (Object.values(latest.pullMergeHistory).some(entry => entry.pullMerge.notification?.status === "queued")) {
      void mergeNotifications.resume(paseo).catch(() => console.warn("Could not resume queued merge notifications."));
    }
    const visible = sessions.filter(row => isCurrentMembership(row, latest));
    const visibleNotes = notes.visible(new Set(visible.map(s => s.id)));
    facts.decorate(visible, evidence, visibleNotes);
    for (const row of visible) {
      decorateDecision(row, visibleNotes[row.id], latest, evidence.get(row.id));
      restoreClarifiedDecision(row, visibleNotes[row.id], latest, evidence.get(row.id));
    }
    const selected = new Set(latest.projects);
    const pullRequests = {
      projects: fetched.projects.filter(p => selected.has(p.projectId)),
      items: fetched.items.map(pr => ({ ...pr, projectIds: pr.projectIds.filter(id => selected.has(id)) })).filter(pr => pr.projectIds.length),
    };
    const targets = new Map(visible.map(row => [row.id, row]));
    if (coordinatorRow && coordinatorRow.id === latest.coordinator) targets.set(coordinatorRow.id, coordinatorRow);
    for (const id of evidence.keys()) if (!targets.has(id)) evidence.delete(id);
    const {history = [], ...trackedDecisions} = tracked.read(selected, visible, pullRequests, evidence);
    if (tracked.hasWaitingReplies()) {
      void resumeReplies({paseo}).catch(()=>console.warn("Could not check waiting board replies."));
    }
    const activity: ReplyEntry[] = [...history];
    for (const [key, receipt] of Object.entries(latest.pullMergeHistory)) {
      if (selected.has(receipt.projectId)) activity.push({...receipt, key, status:"recorded"});
    }
    const updates = new Map<string,string>();
    for (const [id, receipt] of Object.entries(latest.decisionReceipts)) {
      const detail = receipt.activity;
      if (!detail?.projectId || !selected.has(detail.projectId) || (receipt.messageId && receipt.messageId !== id)) continue;
      const reply = detail.recipientId && receipt.status === "sent" ? evidence.get(detail.recipientId)?.replies?.get(id) : undefined;
      if (reply && reply !== receipt.response) updates.set(id, reply);
      activity.push({...detail, origin:detail.origin ?? {sessionId:receipt.sessionId, cardId:receipt.sessionId, revision:receipt.version, questions:[{id:receipt.version}]}, key:id, status:receipt.status, messageId:id, response:reply ?? receipt.response});
    }
    if (updates.size) prefs.change(current => {
      for (const [id,text] of updates) if (current.decisionReceipts[id]) current.decisionReceipts[id].response = text;
    });
    for (const entry of activity) {
      const id = entry.recipientId ?? entry.pullMerge?.notification?.recipientId;
      const target = id && targets.get(id);
      if (!target) { delete entry.response; continue; }
      entry.canOpen = true;
      entry.recipientTitle = target.title;
      entry.recipientState = target.lane === "running" ? "running" : target.status === "idle" || target.status === "closed" || target.status === "error" ? target.status : "unknown";
    }
    const replyHistory = activity.sort((a,b) => b.at.localeCompare(a.at));
    const clarifications = clarificationHistory(prefs, targets, evidence);
    return { sessions: visible, notes: visibleNotes, pullRequests, trackedDecisions, replyHistory, ...(clarifications.length ? { clarifications } : {}),
      projects: [...choices.values()].map(p => ({ ...p, selected: selected.has(p.id) })), coordinator: latest.coordinator };
  }
  async function buildSessionView(paseo: PluginHandlerContext["paseo"],
    catalog: Awaited<ReturnType<PluginHandlerContext["paseo"]["projects"]["list"]>>,
    rows: Awaited<ReturnType<typeof discoverSessions>>) {
    const scope = prefs.read();
    const choices = new Map(catalog.projects.map(p => {
      const id = p.projectId;
      return [id, { id, title: p.projectCustomName || p.projectDisplayName, path: p.projectRootPath, selected: scope.projects.includes(id) }];
    }));
    for (const row of rows) {
      if (!choices.has(row.projectId)) choices.set(row.projectId, { id: row.projectId, title: row.projectTitle, path: "", selected: scope.projects.includes(row.projectId) });
    }
    const titles = new Map([...choices].map(([id, p]) => [id, p.title]));
    const sessions = managedSessions(rows, scope, titles);
    const evidence = await reader.decorate(paseo, sessions, scope);
    const coordinatorRow = rows.find(row => row.id === scope.coordinator);
    if (coordinatorRow && !sessions.some(row => row.id === coordinatorRow.id)) {
      const observed = await reader.read(paseo, coordinatorRow).catch(() => null);
      if (observed) evidence.set(coordinatorRow.id, observed);
    }
    const clarifying = new Set(Object.values(scope.clarifications).flatMap(entry => {
      if (entry.status === "pending" && (entry.card.projectId === null ? scope.projects.length : scope.projects.includes(entry.card.projectId))) {
        return [entry.recipientId];
      }
      const original = sourceQuestion(entry.card);
      return original && entry.savedDecision && original.version !== scope.answers[original.sessionId]?.version
        ? [entry.recipientId] : [];
    }));
    // A running recipient may already have accepted a clarification, even
    // though the regular reader skips its timeline until the turn finishes.
    const recipients = coordinatorRow && isManagedCoordinator(scope, coordinatorRow.id) && !sessions.some(s => s.id === coordinatorRow.id)
      ? [...sessions, coordinatorRow] : sessions;
    for (const row of recipients) {
      if (!clarifying.has(row.id) || evidence.has(row.id) || row.nativePending || row.status === "closed") continue;
      try {
        const page = await paseo.agents.ref(row.id).timeline.refetch({ direction: "tail", projection: "projected", limit: 48 });
        evidence.set(row.id, excerpt(page));
      } catch {
        // Fall back to Paseo's current state when the timeline is unavailable.
      }
    }
    return { choices, sessions, evidence, coordinatorRow };
  }
  const reads = new SnapshotReads<Awaited<ReturnType<typeof buildSnapshot>>>(() => {
    const { projects, sessionLinks, coordinator, projectRepositories } = prefs.read();
    return JSON.stringify([projects, sessionLinks, coordinator, projectRepositories]);
  }, decisionCount);
  const invalidateCount = () => reads.invalidate();
  const clarifications = new ClarificationSender(prefs, (sdk, card) => buildSnapshot(sdk, card.kind === "pull"), (card, view) => {
    const original = sourceQuestion(card);
    if (original) {
      const latest = notes.visible(new Set([original.sessionId]))[original.sessionId];
      if (latest?.revision !== view.notes[original.sessionId]?.revision) return false;
    }
    if (card.kind !== "tracked") return true;
    const scope = prefs.read();
    const records = tracked.read(new Set(scope.projects), [], { items: [], projects: [] });
    const sameCard = (item:{source:string;projectId:string|null;id:string;fingerprint:string}) =>
      item.source === card.source && item.projectId === card.projectId && item.id === card.id && item.fingerprint === card.fingerprint;
    const before = view.trackedDecisions?.items.find(sameCard);
    const now = records.items.find(sameCard);
    return !!before && !!now && now.sourceCoordinatorId === before.sourceCoordinatorId;
  });
  server.handle(askClarification, async (input, { paseo }) => {
    try {
      return await clarifications.send(paseo, input);
    } finally {
      invalidateCount();
    }
  });
  prs.register(server, invalidateCount,mergeNotifications);
  const onRecipientAvailable = async (event: {agent?: {id:string}}, context: PluginHandlerContext) => {
    if (!event.agent?.id) return;
    const id=event.agent.id;
    if (tracked.hasWaitingReplies(id)) {
      await resumeReplies(context,id);
      // The completion hook can precede the daemon's idle projection.
      if (tracked.hasWaitingReplies(id)) {
        await new Promise(resolve=>setTimeout(resolve,250));
        await resumeReplies(context,id);
      }
    }
    await mergeNotifications.resume(context.paseo,event.agent.id);
  };
  const removeMergeTurn = server.addHook("agent.turn.after",onRecipientAvailable);
  const removeReplyClose = server.addHook("agent.close.after",async (event,ctx)=>{ if(event.agent?.id) await resumeReplies(ctx,event.agent.id); });
  const removeReplyArchive = server.addHook("agent.archive.after",async (event,ctx)=>{ if(event.agent?.id) await resumeReplies(ctx,event.agent.id); });
  const removeMergePermission = server.addHook("agent.permission.after",onRecipientAvailable);
  const resumeReplies = tracked.register(server, () => new Set(prefs.read().projects), invalidateCount, async (item,targetId,{paseo}) => {
    let rows = await discoverSessions(paseo);
    const owned = usesSourceCoordinator(item);
    const current = () => {
      const scope = prefs.read();
      const managed = managedSessions(rows,scope);
      if (!scope.projects.length || (item.projectId && !scope.projects.includes(item.projectId))) return false;
      if (trackedRecipient(item,scope.coordinator,managed) !== targetId) return false;
      return !owned || managed.some(row => row.id === targetId) ||
        (isManagedCoordinator(scope,targetId) && targetId === scope.coordinator && rows.some(row => row.id === targetId));
    };
    if (!current()) return null;
    const handle=paseo.agents.ref(targetId);
    if (owned) rows = await discoverSessions(paseo);
    const agent=(await handle.refresh())?.agent;
    if (!current() || !agent || agent.id!==targetId || agent.internal || agent.archivedAt || agent.status==="closed" || agent.status==="error") return null;
    return {
      stillCurrent:current,
      send:async (answer,messageId,images)=>{
        await handle.send(answer,{messageId,activeTurnBehavior:"steer",...(images?.length ? {images} : {})});
      },
      accepted:async (answer,messageId)=>{
        const page=await handle.timeline.refetch({direction:"tail",projection:"projected",limit:128});
        return !page.error && !page.gap && !page.staleCursor && page.entries.some(({item:m})=>m.type==="user_message" &&
          (m.messageId===messageId || m.clientMessageId===messageId) && m.text===answer);
      },
      ready:canReceiveBoardInput(agent,owned || targetId===prefs.read().coordinator),
    };
  });
  server.handle(boardSnapshot, (input, { paseo }) => reads.read(() => buildSnapshot(paseo), input.fresh));
  server.handle(boardDecisionCount, async (_input, { paseo }) => ({
    count: await reads.count(() => buildSnapshot(paseo)),
  }));
  server.handle(boardScope, async (change, { paseo }) => {
    const rows = await discoverSessions(paseo);
    if (change.kind === "project") {
      if (change.enabled && !rows.some(r => r.projectId === change.projectId)) {
        const catalog = await paseo.projects.list();
        if (!catalog.projects.some(p => p.projectId === change.projectId)) throw new Error("이 호스트에서 프로젝트를 찾을 수 없습니다.");
      }
      prefs.change(scope => {
        if (scope.projects.includes(change.projectId) !== change.enabled) delete scope.factCycle;
        scope.projects = scope.projects.filter(id => id !== change.projectId);
        if (change.enabled) scope.projects.push(change.projectId);
        else {
          for (const link of Object.values(scope.sessionLinks)) {
            if (link.targetProjectId === change.projectId) delete scope.sessionLinks[link.sessionId];
          }
          releaseUnmanagedCoordinator(rows, scope);
          for (const [id, d] of Object.entries(scope.judgments)) if (d.projectId === change.projectId) delete scope.judgments[id];
        }
        reader.retain(new Set(managedSessions(rows, scope).map(r => r.id)));
      });
    } else {
      prefs.change(scope => {
        if (change.sessionId && !managedSessions(rows, scope).some(r => r.id === change.sessionId)) throw new Error("관리할 프로젝트의 세션을 선택해 주세요.");
        setCoordinator(scope, change.sessionId);
      });
    }
    invalidateCount();
    return { ok: true };
  });
  server.handle(saveNote, async (input, { paseo }) => {
    const sessions = await discoverSessions(paseo);
    if (!managedSessions(sessions, prefs.read()).some(session => session.id === input.sessionId)) {
      throw new Error("이 호스트에서 해당 세션을 찾지 못했습니다. 보드를 새로 고쳐 주세요.");
    }
    const outcome = notes.update(input);
    if (outcome.ok) invalidateCount();
    return outcome;
  });

  server.handle(setReporting, async ({ sessionId, enabled }, { paseo }) => {
    const sessions = await discoverSessions(paseo);
    if (!managedSessions(sessions, prefs.read()).some(session => session.id === sessionId)) throw new Error("세션을 찾지 못했습니다.");
    await paseo.agents.ref(sessionId).setMetadata({ [reportingKey]: enabled });
    invalidateCount();
    return { ok: true };
  });
  const removeReport = attachReportTool(server, notes);
  const removeCoordinator = attachCoordinatorTools(server, prefs, reader, [...operations.tools, facts.tool, trackedReviewTool(prefs, tracked, prs, reader, invalidateCount)]);
  return () => { removeMergeTurn(); removeMergePermission(); removeReplyClose(); removeReplyArchive(); removeCoordinator(); removeReport(); };
}
