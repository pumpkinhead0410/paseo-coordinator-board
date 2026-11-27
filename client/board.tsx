import type { BoardReadiness } from "../shared/readiness";
import { matchesProject, historySessionLinks, type HistoryLinks } from "./history-sessions";
import { ReplyHistory } from "./reply-history";
import { trackedSessionTargets } from "./tracked-session-targets";
import type { TrackedSessionLinks } from "./tracked-session-chips";
import { TrackedDecisionCard } from "./tracked-decisions";
import { mentionsSecurityGate, trackedCoverage, trackedRecipient, usesSourceCoordinator, pullKey, type TrackedDecision } from "../shared/tracked-decisions";
import { MergeFeedback, PullRequestCard, PullRequestSettings, type MergeNotice, type WorkSessionLink } from "./pull-requests";
import { pullRowKey, recordRowKey, sessionRowKey, withReceiptPositions, type CompletedAction, type InlineReceipt } from "./decision-receipts";
import { rankDecisionRows, priorityLabel } from "./decision-priority";
import { DecisionEditingRow, keepEditingPositions, useDecisionEditing } from "./decision-editing";
import { InlineDecisionReceipt } from "./inline-receipt";
import { latestMergeNotification } from "./merge-notification";
import { decisionSummary } from "./decision-summary";
import { matchesWorkspace } from "../shared/workspace-pull";
import type { PullRequestItem } from "../shared/prs";
import { getPaseoClient, type PluginScreenProps } from "@getpaseo/plugin/client";
import { remoteScope, readRemoteHistorySession } from "./remote-sessions";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { DecisionActions, type DecisionReceipt } from "./decision-actions";
import { Clarification } from "./clarification";
import { clarificationKey, clarificationRecipient, sessionClarificationCard, trackedClarificationCard, type ClarificationCard } from "../shared/clarifications";
import { SessionLinks } from "./session-links";
import { useRemoteRunning, RemoteRunning } from "./remote-running";
import { BoardHosts } from "./hosts";
import { OperationsPanel } from "./operations";
import { Button, type Theme } from "./controls";
import { Project } from "./project-kanban";
import { SessionProgress } from "./session-progress";
import { BoardLanguageSetting, useBoardLanguage } from "./language";
import { projectCards, projectFilterNames, type Card, type Snapshot } from "./model";

type Actions = { sessionHostLabel?: string; coordinator?: string | null; onCoordinator?: (id: string | null) => void; changing?: boolean; onOpen?: (id: string) => void; onEdit: (id: string) => void };

export type BoardViewProps = Actions & {
  theme: Theme; layout: PluginScreenProps["layout"]; hostLabel: string; hostId?: string; onOpenHostSession?: (serverId: string, agentId: string) => void;
  readiness?: BoardReadiness | null; snapshot: Snapshot | null; error: string | null; loading: boolean; updatedAt: Date | null;
  onRefresh: () => void; onProject?: (id: string, enabled: boolean) => void;
};

export function BoardView({ snapshot, readiness, theme, layout, hostLabel, hostId, onOpenHostSession, error, loading, updatedAt, onRefresh, onProject, ...actions }: BoardViewProps) {
  const { t, language } = useBoardLanguage();
  const { human, projects } = useMemo(() => snapshot ? projectCards(snapshot) : { human: [], projects: [] }, [snapshot]);
  const pullRequests = snapshot?.pullRequests;
  const readyPrs = pullRequests?.items.filter(pr => pr.lane === "review") ?? [];
  const records = useMemo(() => {
    const priority = (urgency: string | null | undefined) => ["now","today","week"].includes(urgency ?? "") ? ["now","today","week"].indexOf(urgency!) : 3;
    return [...snapshot?.trackedDecisions?.items ?? []].sort((a,b) => priority(a.urgency) - priority(b.urgency) ||
      (a.where === "human" ? 0 : 1) - (b.where === "human" ? 0 : 1) || (a.since ?? "~").localeCompare(b.since ?? "~"));
  }, [snapshot?.trackedDecisions]);
  const [inlineReceipts, setInlineReceipts] = useState<InlineReceipt[]>([]);
  const completed = new Set(inlineReceipts.map(receipt => receipt.actionKey));
  const names = new Map(snapshot?.projects.map(project => [project.id, project.title]));
  const displayed = new Map(projects.map(project => [project.id, project]));
  for (const pr of pullRequests?.items ?? []) for (const id of pr.projectIds) {
    if (!displayed.has(id)) displayed.set(id, {id,title:names.get(id) ?? id,cards:[]});
  }
  function decisionsFor(inScope:(id:string|null)=>boolean) {
    const visibleRecords=records.filter(item=>inScope(item.projectId) && !completed.has(recordRowKey(item)));
    const covered=trackedCoverage(visibleRecords);
    return {
      records:visibleRecords,
      sessions:human.filter(card=>inScope(card.session.projectId) && !completed.has(sessionRowKey(card)) && !covered.sessionIds.has(card.session.id)),
      prs:readyPrs.filter(pr=>pr.projectIds.some(inScope) && !completed.has(pullRowKey(pr)) && !covered.pullKeys.has(pullKey(pr.repo,pr.number))),
    };
  }
  const allPending = decisionsFor(() => true);
  const total = allPending.prs.length + allPending.records.length + allPending.sessions.length;
  const byProject=new Map<string|null,number>();
  const projectIds=new Set<string|null>(snapshot?.projects.filter(p=>p.selected).map(p=>p.id));
  for (const item of records) {
    projectIds.add(item.projectId);
    if (item.projectId && !displayed.has(item.projectId)) displayed.set(item.projectId,{id:item.projectId,title:names.get(item.projectId) ?? item.projectTitle ?? item.projectId,cards:[]});
  }
  const history = snapshot?.replyHistory ?? [];
  useEffect(() => {
    const stored = new Map(snapshot?.replyHistory?.flatMap(entry => entry.pullMerge?.status === "merged" && entry.pullMerge.notification
      ? [[JSON.stringify([entry.projectId, pullRowKey(entry.pullMerge)]), entry.pullMerge.notification] as const] : []));
    if (!stored.size) return;
    setInlineReceipts(previous => {
      const next = previous.map(receipt => {
        if (receipt.status !== "merged") return receipt;
        const notification = latestMergeNotification(receipt.notification, stored.get(JSON.stringify([receipt.mergeProjectId, receipt.actionKey])));
        return notification === receipt.notification ? receipt : { ...receipt, notification };
      });
      return next.some((receipt, index) => receipt !== previous[index]) ? next : previous;
    });
  }, [snapshot?.replyHistory, inlineReceipts.length]);
  for (const entry of history) {
    projectIds.add(entry.projectId);
    if (entry.projectId && !displayed.has(entry.projectId)) displayed.set(entry.projectId,{id:entry.projectId,title:names.get(entry.projectId) ?? entry.projectId,cards:[]});
  }
  if (inlineReceipts.some(receipt => !receipt.hidden && receipt.projectIds.includes(null))) projectIds.add(null);
  for (const id of projectIds) {
    const list=decisionsFor(projectId=>projectId===id);
    byProject.set(id,list.records.length+list.sessions.length+list.prs.length);
  }
  const [chosenProjects,setChosenProjects]=useState<(string|null)[]>([]);
  const filters=chosenProjects.filter(id=>byProject.has(id));
  const inFilter=(id:string|null)=>!filters.length || filters.includes(id);
  const visibleProjects = [...displayed.values()].filter(project => inFilter(project.id));
  const showHostWide = byProject.has(null) && inFilter(null);
  const {records:filteredRecords,sessions:filteredSessions,prs:filteredPrs}=decisionsFor(inFilter);
  const filteredTotal=filteredRecords.length+filteredSessions.length+filteredPrs.length;
  const filteredHistory=history.filter(entry=>inFilter(entry.projectId));
  const [historyOpen,setHistoryOpen]=useState<boolean|null>(null);
  const filterNames = projectFilterNames(snapshot?.projects.filter(project => byProject.has(project.id)) ?? []);
  const projectName=(id:string|null)=>filterNames.get(id ?? "") ?? displayed.get(id ?? "")?.title ?? id ?? t("공통","Host-wide");
  function toggleFilter(id:string|null) {
    setChosenProjects(previous=>{
      const active=previous.filter(value=>byProject.has(value));
      return active.includes(id) ? active.filter(value=>value!==id) : [...active,id];
    });
  }
  const incomplete = snapshot?.trackedDecisions && ["partial","unavailable","invalid"].includes(snapshot.trackedDecisions.status);
  const [settings, setSettings] = useState(false);
  const {groups: peers, loading: peersLoading} = useRemoteRunning({id:hostId ?? "",label:hostLabel}, snapshot?.projects ?? [], pullRequests?.projects ?? [], !!hostId && !settings);
  const visiblePeers = peers.map(group => ({...group, rows: group.rows.filter(row => inFilter(row.projectId))}));
  const historyRepos = useMemo(() => new Map(pullRequests?.projects.flatMap(p =>
    p.repo && p.mode !== "off" ? [[p.projectId,p.repo] as const] : [])), [pullRequests?.projects]);
  const historyScope = useMemo(() => remoteScope(snapshot?.projects ?? [],pullRequests?.projects ?? []), [snapshot?.projects,pullRequests?.projects]);
  const scopeKey = JSON.stringify([hostId, historyScope, peers.map(p=>p.host.serverId).sort()]);
  const currentHistoryScope = useRef(scopeKey);
  currentHistoryScope.current = scopeKey;
  const historyLinks:HistoryLinks = entry => historySessionLinks(entry, {
    hostId, sessions:snapshot?.sessions ?? [], peers, repos:historyRepos,
    verifyRemote:(host,id,project) => readRemoteHistorySession(getPaseoClient(host),id,project,historyScope,()=>currentHistoryScope.current===scopeKey),
  });
  const [showError, setShowError] = useState(false);
  const [manage, setManage] = useState(false);
  const [pickSession, setPickSession] = useState(false);
  const configured = snapshot ? snapshot.projects.some(p => p.selected) : readiness?.configured;
  const pickingProjects = !configured || (!settings && !snapshot?.coordinator);
  const coordinatorId = snapshot ? snapshot.coordinator : readiness?.coordinator;
  const operationsReady = !!snapshot || !!(readiness?.configured && readiness.coordinator && !settings);
  const openCoordinator = coordinatorId && actions.onOpen ? () => actions.onOpen?.(coordinatorId) : undefined;
  const [digestLimit, setDigestLimit] = useState(5);
  const [mergeNotice, setMergeNotice] = useState<MergeNotice | null>(null);

  const [receipts, setReceipts] = useState<DecisionReceipt[]>([]);
  const matches = (r: DecisionReceipt, card: Card) => r.projectId === card.session.projectId && r.sessionId === card.session.id && r.version === card.session.decision?.version;
  const now = Date.now();
  const ranked = rankDecisionRows({ prs: filteredPrs, records: filteredRecords, sessions: filteredSessions }, now);
  const rankedKeys = ranked.map(row => row.key);
  const { positions, onEditing } = useDecisionEditing(rankedKeys);
  const shownKeys = keepEditingPositions(rankedKeys, positions).slice(0, digestLimit);
  const remaining = ranked.length - shownKeys.length;
  const scopedReceipts = inlineReceipts.filter(receipt => receipt.projectIds.some(id => byProject.has(id) && inFilter(id)));
  const showHistory = historyOpen ?? (filteredTotal === 0 && !scopedReceipts.some(receipt => !receipt.hidden));
  const orderedKeys = withReceiptPositions(shownKeys, scopedReceipts);
  function remember(action: CompletedAction) {
    // The callback captures the order at the time the person pressed the button.
    setInlineReceipts(previous => previous.some(entry => entry.actionKey === action.actionKey && entry.rowKey === action.rowKey)
      ? previous : [...previous, { ...action, order: orderedKeys }]);
  }
  function questionFor(card: ClarificationCard | null, title: string, prior?: TrackedDecision["qa"], onDraftChange?: (active:boolean) => void, ownerId?: string | null) {
    if (!snapshot) return null;
    const recipientId = card ? clarificationRecipient(card, snapshot) : null;
    const recipientTitle = ownerId && ownerId === recipientId ? t("운영 코디네이터", "Ledger owner") + " · " + ownerId
      : snapshot.sessions.find(row => row.id === recipientId)?.title;
    return <Clarification key={card ? clarificationKey(card) : title} title={title} card={card} theme={theme}
      recipientId={recipientId} recipientTitle={recipientTitle} entries={snapshot.clarifications ?? []} prior={prior} onRefresh={onRefresh} onDraftChange={onDraftChange} />;
  }
  const renderDecision = (card: Card, embedded = false, rowKey?: string, priority?: string) => <DecisionActions key={JSON.stringify([card.session.projectId, card.session.id, card.session.decision?.version])}
          clarification={!embedded && questionFor(sessionClarificationCard(card.session,card.note),card.session.title)}
          embedded={embedded} priorityLabel={priority} card={card} hostLabel={hostLabel} theme={theme} coordinator={snapshot!.coordinator} coordinatorTitle={snapshot!.sessions.find(s => s.id === snapshot!.coordinator)?.title}
          open={actions.onOpen} receipt={receipts.find(r => matches(r, card))}
          onSent={result => {
            if (rowKey && result.action === "reply") remember({
              rowKey, actionKey: sessionRowKey(card), projectIds: [result.projectId], status: "sent", recipientId: result.recipientId,
              title: decisionSummary(card, t).headline, detail: result.answer || result.recipient || undefined,
            });
            setReceipts(prior => [result, ...prior.filter(r => !(r.projectId === result.projectId && r.sessionId === result.sessionId))].slice(0, 20));
            onRefresh();
          }} />;
  function linkedSession(item: TrackedDecision) {
    const id = item.matchedSessionId || item.sessionId;
    if (!id) return;
    if (item.sessionHost && item.sessionHost !== hostId) {
      const peer = peers.find(g => g.host.serverId === item.sessionHost && g.rows.some(s => s.sessionId === id && s.projectId === item.projectId));
      return peer && onOpenHostSession ? () => onOpenHostSession(peer.host.serverId,id) : undefined;
    }
    const local = snapshot?.sessions.find(s => s.id === id && (matchesProject(s.projectId,item.projectId,historyRepos) || s.id === item.matchedSessionId));
    return local && actions.onOpen ? () => actions.onOpen!(local.id) : undefined;
  }
  function recordLinks(item: TrackedDecision, showSource = true): TrackedSessionLinks {
    if (!snapshot) return {};
    const { ownerId, sameSession } = trackedSessionTargets(item, snapshot.coordinator, hostId);
    const open = actions.onOpen;
    const ownerKnown = ownerId === snapshot.coordinator || snapshot.sessions.some(session => session.id === ownerId);
    const owner = ownerId && open && (ownerKnown || hostId) ? {
      id: ownerId,
      open: () => open(ownerId),
      verify: !ownerKnown && hostId ? async () => {
        const entry = await getPaseoClient(hostId).agents.ref(ownerId).refresh();
        return entry?.agent.id === ownerId && !entry.agent.internal && !entry.agent.archivedAt;
      } : undefined,
    } : undefined;
    return { owner, source: showSource && !(owner && sameSession) ? linkedSession(item) : undefined };
  }
  function renderPull(pr:PullRequestItem, projectId:string, decision=false, securityGate=false, embedded=false, rowKey?: string, scope: (string | null)[] = pr.projectIds, priority?: string) {
    const workSessions:WorkSessionLink[] = [];
    for (const s of snapshot?.sessions ?? []) {
      if (!inFilter(s.projectId) || !pr.projectIds.includes(s.projectId) || !actions.onOpen || !matchesWorkspace(pr,s.workspacePull)) continue;
      const state = s.status === "closed" ? t("대화 종료","Closed") : s.lane === "running" ? t("진행 중","Running") : s.status === "idle" ? t("대기","Idle") : t("상태 확인 필요","Check status");
      workSessions.push({key:JSON.stringify([hostId,s.id]),label:[s.title,hostLabel,state].join(" · "),open:()=>actions.onOpen!(s.id)});
    }
    if (onOpenHostSession) for (const {host,rows} of peers) for (const s of rows) {
      if (!inFilter(s.projectId) || !pr.projectIds.includes(s.projectId) || !matchesWorkspace(pr,s.workspacePull)) continue;
      workSessions.push({key:JSON.stringify([host.serverId,s.sessionId]),label:[s.title || t("작업 세션","Work session"),host.label,t("진행 중","Running")].join(" · "),open:()=>onOpenHostSession(host.serverId,s.sessionId)});
    }
    return <PullRequestCard key={JSON.stringify([pr.url,projectId])} pr={pr} projectId={projectId} theme={theme} priorityLabel={priority} workSessions={workSessions}
      clarification={decision && !embedded && questionFor({kind:"pull",projectId,repo:pr.repo,number:pr.number,updatedAt:pr.updatedAt},pr.repo + " #" + pr.number)}
      decision={decision} showDivider={!decision || embedded} securityGate={securityGate} openCoordinator={openCoordinator} onResult={notice => {
        const { status } = notice;
        const merged = status === "merged" || status === "already-merged";
        if (rowKey && merged) {
          remember({ rowKey, actionKey: pullRowKey(pr), projectIds: scope, status,
            title: pr.title, detail: notice.target, mergeProjectId: projectId, notification: notice.notification });
        }
        setMergeNotice(rowKey && merged ? null : notice);
        onRefresh();
      }} />;
  }
  const renderRecord = (item: TrackedDecision, rowKey?: string, priority?: string) => {
          const native = human.find(card => card.session.id === item.matchedSessionId);
          const pr = item.kind === "merge" && item.mergeTarget && pullRequests?.items.find(pr =>
            pr.repo === item.mergeTarget?.repo && pr.number === item.mergeTarget.number &&
            (!item.projectId || pr.projectIds.includes(item.projectId)) && (pr.reason !== "ready" || item.matchedPull));
          const recipient = trackedRecipient(item,snapshot!.coordinator,snapshot!.sessions);
          const replyRecipient = native && !item.questions.length ? undefined : recipient;
          return <TrackedDecisionCard links={recordLinks(item, !native)} key={item.key} item={item} theme={theme} priorityLabel={priority}
            renderClarification={onDraftChange => questionFor(trackedClarificationCard(item,snapshot!.sessions),item.title,item.qa,onDraftChange,usesSourceCoordinator(item) ? item.sourceCoordinatorId : undefined)}
            pull={rowKey && item.mergeTarget && scopedReceipts.some(receipt => receipt.rowKey === rowKey && receipt.actionKey === pullRowKey(item.mergeTarget!)) ? <></>
              : pr && renderPull(pr, pr.projectIds.includes(item.projectId ?? "") ? item.projectId! : pr.projectIds[0], true, mentionsSecurityGate(item), true, rowKey, [item.projectId])}
            recipientId={replyRecipient} onResolved={(status,mode,answer)=>{
              if (rowKey && mode && (status === "sent" || status === "closed" || status === "already-closed")) {
                remember({ rowKey, actionKey: recordRowKey(item), projectIds: [item.projectId],
                  status: status === "closed" ? (mode === "save" ? "saved" : "reviewed") : status,
                  recipientId: status === "sent" && mode === "send" ? replyRecipient ?? undefined : undefined,
                  title: item.title, detail: answer || item.projectTitle || projectName(item.projectId) });
              }
              onRefresh();
            }}>
            {native && (!rowKey || !completed.has(sessionRowKey(native))) && renderDecision(native,true,rowKey)}
          </TrackedDecisionCard>;
        };
  const rowsByKey = new Map(ranked.map(row => [row.key, row]));
  const activeRows = new Map<string, ReactNode>();
  shownKeys.forEach((key, position) => {
    const row = rowsByKey.get(key)!;
    const label = priorityLabel(row, t, now);
    let content: ReactNode;
    switch (row.kind) {
      case "pull":
        content = renderPull(row.pr, row.pr.projectIds.find(inFilter) ?? row.pr.projectIds[0], true, false, false, key, row.pr.projectIds, label);
        break;
      case "record":
        content = renderRecord(row.item, key, label);
        break;
      case "session":
        content = renderDecision(row.card, false, key, label);
        break;
    }
    activeRows.set(key, <DecisionEditingRow rowKey={key} position={position} onEditing={onEditing}>{content}</DecisionEditingRow>);
  });
  const [activeTab, setActiveTab] = useState<"work" | "kanban">("work");
  const c = theme.colors;
  const pendingCount = filters.length ? filteredTotal : total;
  const visibleCards = visibleProjects.flatMap(project => project.cards);
  const runningCount = visibleCards.filter(card => card.lane === "running").length;
  const reviewCount = visibleCards.filter(card => card.lane === "review").length;
  const idleCount = visibleCards.filter(card => card.lane === "idle").length;
  const historyCount = filteredHistory.length;
  const kanbanTotal = visibleCards.length + historyCount;
  const decisionsSection = <>
      {!settings && !snapshot && !error && !!readiness?.decisionTitles?.length && <View style={{ gap: 6 }}>
        <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, fontWeight: "700" }}>{t("내 결정", "My decisions")}</Text>
        {readiness.decisionTitles.map((title, index) => <Text key={index} numberOfLines={2} style={{ color: c.foreground }}>{title}</Text>)}
        <Text style={{ color: c.foregroundMuted }}>{t("세션과 PR 상태를 확인하고 있어요.", "Checking session and PR status…")}</Text>
      </View>}
      {!settings && snapshot && configured && <View style={{ gap: layout.compact ? 12 : 16 }}>
        <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, fontWeight: "700" }}>{filters.length ? t(`내 결정 · ${filteredTotal}건 / 전체 ${total}건`, `My decisions · ${filteredTotal} of ${total}`) : t(`내 결정 · ${total}건`, `My decisions · ${total}`)}</Text>
        {incomplete &&
          <Text accessibilityLiveRegion="polite" style={{ color: c.statusWarning }}>{t("일부 결정 기록을 읽지 못했습니다. 현재 건수에는 확인한 항목만 포함됩니다.", "Some decision records could not be loaded. The count includes the available items.")}</Text>}
        {filters.length > 0 && !filteredTotal && total > 0 && !incomplete && <Text style={{color:c.foregroundMuted}}>{t("선택한 프로젝트에 결정할 일이 없습니다.","No decisions in the selected projects.")}</Text>}
        {pendingCount === 0 && !incomplete && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 9, backgroundColor: "rgba(16, 185, 129, 0.08)", borderWidth: 1, borderColor: "rgba(16, 185, 129, 0.25)" }}>
          <Text style={{ color: c.statusSuccess, flex: 1, minWidth: 180 }}>{t("✓ 지금 결정할 일이 없습니다. 바로 새 작업을 맡기거나 세션 진행을 확인하세요.", "✓ No decisions are waiting. Assign new work or check session progress.")}</Text>
          <Button theme={theme} label={t("세션 진행 보기 ›", "View progress ›")} onPress={() => setActiveTab("kanban")} />
        </View>}
        {mergeNotice && inFilter(mergeNotice.projectId) && snapshot.projects.some(p => p.selected && p.id === mergeNotice.projectId) && (mergeNotice.status === "merged" || mergeNotice.status === "already-merged" ||
          !readyPrs.some(pr => pr.repo + " #" + pr.number === mergeNotice.target)) && <MergeFeedback notice={mergeNotice} theme={theme} />}
        {orderedKeys.map(key => <View key={key} role="article" style={{ gap: 8, padding: layout.compact ? 12 : 16, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, borderLeftWidth: 4, borderLeftColor: c.statusDanger, borderRadius: 10 }}>
          {scopedReceipts.filter(receipt => receipt.rowKey === key && !receipt.hidden).map(receipt =>
            <InlineDecisionReceipt key={receipt.actionKey} receipt={receipt} theme={theme} onOpen={actions.onOpen} onDismiss={() =>
              setInlineReceipts(prior => prior.map(entry => entry === receipt ? { ...entry, hidden: true } : entry))} />)}
          {activeRows.get(key)}
        </View>)}
        {remaining > 0 && <Button theme={theme} label={t(`결정 ${remaining}건 더 보기`, `Show ${remaining} more decisions`)} onPress={() => setDigestLimit(total)} />}
      </View>}
  </>;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ gap: 18, padding: layout.compact ? 12 : 22 }}>
      <View style={{ width: "100%", gap: 18 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <View style={{ flex: 1, minWidth: 140, gap: 3 }}>
          <Text style={{ color: c.foreground, fontSize: 22, fontWeight: "700" }} accessibilityRole="header">{settings ? t("코디네이터 보드 설정", "Coordinator board settings") : t("세션별 코디네이터 보드", "Session coordinator board")}</Text>
          {error ? <Text accessibilityRole="button" accessibilityLiveRegion="polite" onPress={() => setShowError(open => !open)}
            style={{ color: c.statusDanger, fontSize: 13, textDecorationLine: "underline" }}>
            {snapshot ? t("갱신 실패 · 이전 결과 표시 · 오류 상세", "Refresh failed · Showing last result · Details") : t("조회 실패 · 오류 상세", "Could not load sessions · Details")}
          </Text> : <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{[hostLabel, updatedAt ? (language === "ko" ? `${updatedAt.toLocaleTimeString("ko-KR")} 갱신` : `Updated ${updatedAt.toLocaleTimeString("en-US")}`) : t("세션 조회 중…", "Loading sessions…")].filter(Boolean).join(" · ")}</Text>}
        </View>
        {!settings && <Button theme={theme} label={loading ? t("조회 중…", "Refreshing…") : t("새로 고침", "Refresh")} onPress={onRefresh} disabled={loading} />}
        <Button theme={theme} label={settings ? t("보드로 돌아가기", "Back to board") : t("설정", "Settings")} onPress={() => {
          setSettings(!settings); setManage(false); setPickSession(false);
        }} />
      </View>
      {!settings && configured && snapshot && <View style={{ gap: 10 }}>
        <View accessibilityLabel={t("보드 상태 요약", "Board status summary")} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, padding: 8, borderRadius: 9, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border }}>
          {[
            { label: t(`내 결정 ${pendingCount}건`, `Decisions ${pendingCount}`), color: pendingCount > 0 ? c.statusDanger : c.statusSuccess, urgent: pendingCount > 0, tab: "work" as const },
            { label: t(`진행 중 ${runningCount}`, `Running ${runningCount}`), color: "#3b82f6", urgent: false, tab: "kanban" as const },
            { label: t(`확인 대기 ${reviewCount}`, `Review ${reviewCount}`), color: c.statusWarning, urgent: false, tab: "kanban" as const },
            { label: t(`결정 후속 ${historyCount}`, `Follow-up ${historyCount}`), color: "#a855f7", urgent: false, tab: "kanban" as const },
            { label: t(`대기 중 ${idleCount}`, `Idle ${idleCount}`), color: c.foregroundMuted, urgent: false, tab: "kanban" as const },
          ].map((item, idx) => <Pressable key={idx} accessibilityRole="button" onPress={() => setActiveTab(item.tab)}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999,
              backgroundColor: item.urgent ? "rgba(239, 68, 68, 0.14)" : c.surface2,
              borderWidth: 1, borderColor: item.urgent ? c.statusDanger : "transparent" }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: item.color }} />
            <Text style={{ fontSize: 12, fontWeight: item.urgent ? "600" : "400", color: c.foreground }}>{item.label}</Text>
          </Pressable>)}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: c.border }}>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Button theme={theme} label={t(`작업 · 결정 (${pendingCount})`, `Work · Decisions (${pendingCount})`)} selected={activeTab === "work"} onPress={() => setActiveTab("work")} />
            <Button theme={theme} label={t(`세션 진행 (${kanbanTotal})`, `Session progress (${kanbanTotal})`)} selected={activeTab === "kanban"} onPress={() => setActiveTab("kanban")} />
          </View>
          {byProject.size > 0 && <View accessibilityLabel={t("프로젝트 필터","Project filters")} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            <Button theme={theme} label={t(`전체 ${total}`,`All ${total}`)} selected={!filters.length} onPress={() => setChosenProjects([])} />
            {[...byProject].map(([id,count]) => <Button key={JSON.stringify(id)} theme={theme} toggle selected={filters.includes(id)}
              label={`${projectName(id)} · ${count}`} onPress={() => toggleFilter(id)} />)}
          </View>}
        </View>
      </View>}
      {!!error && showError && <Text selectable style={{ color: c.statusDanger }}>{error}</Text>}
      {settings && <BoardLanguageSetting theme={theme} />}
      {!!error && settings && <Button theme={theme} label={t("세션 다시 조회", "Retry session lookup")} disabled={loading} onPress={onRefresh} />}
      {snapshot && onProject && (pickingProjects || settings) && <View style={{ gap: 7 }}>
        {!pickingProjects
          ? <Button theme={theme} label={manage ? t("프로젝트 관리 닫기", "Close project selection") : t("보드에서 관리할 프로젝트 선택", "Choose projects to manage")} onPress={() => setManage(!manage)} />
          : <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, fontWeight: "600" }}>{t("다이제스트에서 관리할 프로젝트 선택", "Select projects for your digest")}</Text>}
        {(pickingProjects || manage) && <>
          <Text style={{ color: c.foregroundMuted }}>{t("선택한 프로젝트의 최근 대화를 읽어 내 결정을 찾습니다. 코디네이터를 지정하면 그 세션도 선택한 프로젝트의 발췌를 볼 수 있습니다.", "The board reads recent conversations in selected projects to find decisions. The assigned coordinator can also read excerpts from those projects.")}</Text>
          {snapshot.projects.map(p => <Button key={p.id} theme={theme} selected={p.selected} disabled={actions.changing}
            label={`${p.selected ? t("관리에서 제외", "Remove") : t("추가", "Add")} · ${p.title}${snapshot.projects.some(x => x.id !== p.id && x.title === p.title) ? " · " + (p.path || p.id) : ""}`}
            onPress={() => onProject(p.id, !p.selected)} />)}
        </>}
      </View>}
      {settings && snapshot && configured && <SessionLinks projects={snapshot.projects} theme={theme} onChange={onRefresh} />}
      {settings && pullRequests && !!configured && <PullRequestSettings view={pullRequests} names={names} theme={theme} refresh={onRefresh} />}
      {settings && hostId && <>
        <BoardHosts current={{ id: hostId, label: hostLabel }} settings theme={theme} open={onOpenHostSession} />
        <BoardHosts current={{ id: hostId, label: hostLabel }} settings={false} theme={theme} open={onOpenHostSession} />
      </>}
      {settings || !configured || !snapshot ? <>
        <OperationsPanel settings={operationsReady && settings} theme={theme} coordinator={operationsReady ? coordinatorId ?? null : null} configured={operationsReady && !!configured}
          refreshBoard={onRefresh} openCoordinator={actions.onOpen} />
        {settings && snapshot && actions.onCoordinator && <View style={{ gap: 8 }}>
          <Button theme={theme} label={pickSession ? t("기존 세션 목록 닫기", "Close session list") : t("기존 세션에서 코디네이터 지정", "Choose an existing coordinator session")} onPress={() => setPickSession(!pickSession)} />
          {pickSession && <>
            {snapshot.coordinator && <Button theme={theme} disabled={actions.changing} label={t("현재 코디네이터 지정 해제", "Clear current coordinator")} onPress={() => actions.onCoordinator?.(null)} />}
            {snapshot.sessions.filter(s => s.id !== snapshot.coordinator).map(s => <Button key={s.id} theme={theme} disabled={actions.changing}
              label={`${s.projectTitle} · ${s.title} · ${t("지정", "Assign")}`} onPress={() => actions.onCoordinator?.(s.id)} />)}
            {!snapshot.sessions.length && <Text style={{ color: c.foregroundMuted }}>{t("관리할 프로젝트를 선택하면 지정할 수 있는 세션이 표시됩니다.", "Select a project to see its available sessions.")}</Text>}
          </>}
        </View>}
        {decisionsSection}
      </> : activeTab === "work" ? <View style={{ gap: 20 }}>
        {decisionsSection}
        <View style={{ height: 1, backgroundColor: c.border }} />
        <OperationsPanel settings={false} theme={theme} coordinator={operationsReady ? coordinatorId ?? null : null} configured={operationsReady && !!configured}
          refreshBoard={onRefresh} openCoordinator={actions.onOpen} />
        {filteredHistory.length > 0 && <ReplyHistory links={historyLinks} openRemote={onOpenHostSession} entries={filteredHistory} theme={theme} open={actions.onOpen} expanded={showHistory} onToggle={() => setHistoryOpen(!showHistory)} />}
      </View> : null}
      {!settings && snapshot && !configured && !snapshot.projects.length && <Text style={{ color: c.foregroundMuted }}>{t("표시할 세션이 없습니다. 워크스페이스에서 세션을 시작하면 여기에 나타납니다.", "Start a session in a workspace to see it here.")}</Text>}
      </View>
      {!settings && configured && snapshot && activeTab === "kanban" && <SessionProgress theme={theme} cards={visibleCards}
        peers={visiblePeers} peersLoading={peersLoading} hostLabel={hostLabel} projectName={projectName} open={actions.onOpen} openRemote={onOpenHostSession}>
        {!visibleProjects.length && !showHostWide && <Text style={{ color: c.foregroundMuted }}>{t("표시할 세션이 없습니다.", "No sessions to show.")}</Text>}
        {showHostWide && <Project historyLinks={historyLinks} openRemote={onOpenHostSession} projectId="" title={t("공통","Host-wide")} cards={[]} requests={[]} history={history.filter(entry=>entry.projectId === null)}
          records={records.filter(item=>item.projectId === null)} decisions={byProject.get(null) ?? 0} renderRecord={renderRecord} renderPull={renderPull}
          recordLinks={recordLinks} compact={layout.compact} theme={theme} {...actions} />}
        {visibleProjects.map((p) => <Project historyLinks={historyLinks} openRemote={onOpenHostSession} projectId={p.id} history={history.filter(entry=>entry.projectId===p.id)} records={records.filter(r => r.projectId === p.id)} renderRecord={renderRecord} decisions={byProject.get(p.id) ?? 0} sessionHostLabel={hostLabel} renderPull={renderPull} recordLinks={recordLinks} requests={pullRequests?.items.filter(pr => pr.projectIds.includes(p.id)) ?? []} key={p.id} title={p.title} cards={p.cards} compact={layout.compact} theme={theme} {...actions} />)}
        <RemoteRunning groups={visiblePeers} projects={snapshot.projects} open={onOpenHostSession} theme={theme} />
      </SessionProgress>}
    </ScrollView>
  );
}
