import { pollQuotaNotices } from "./client/quota-delivery";
import { boardReadiness, type BoardReadiness } from "./shared/readiness";
import { DecisionBadge, publishDecisionCount } from "./client/decision-badge";
import { decisionCount } from "./shared/decision-count";
import type { z } from "zod";
import { useRpc, type PluginClientContext, type PluginScreenProps, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow, useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { boardScope, boardSnapshot, claimBoardQuotaNotice, saveNote, setReporting } from "./shared/contract";
import { BoardLanguageProvider, useBoardLanguage } from "./client/language";
import { BoardView } from "./client/board";
import { NoteEditor } from "./client/note-editor";
import { SessionPhotoMessage } from "./client/session-photos";
import { boardPhotoMessageSchema, isBoardPhotoMessage } from "./shared/session-photos";
import type { NoteInput, Snapshot } from "./client/model";

function useQuotaNotices(hostId: string, enabled = true) {
  const read = useRpc(claimBoardQuotaNotice);
  const toast = useToast();
  const current = useRef({ read, toast });
  current.current = { read, toast };
  useEffect(() => {
    if (!enabled) return;
    const { toast: hostToast } = current.current;
    return pollQuotaNotices(async () => (await current.current.read({})).message,
      message => hostToast.show(message, { variant: "warning", durationMs: 18000 }));
  }, [hostId, enabled]);
}

function HostBoard({ host, theme, layout, navigation }: PluginScreenProps) {
  useQuotaNotices(host.id);
  const getBoard = useRpc(boardSnapshot);
  const readyRpc = useRpc(boardReadiness);
  const readyRef = useRef(readyRpc);
  readyRef.current = readyRpc;
  const [readiness, setReadiness] = useState<BoardReadiness | null>(null);
  const save = useRpc(saveNote);
  const changeReporting = useRpc(setReporting);
  const configure = useRpc(boardScope);
  const [changing, setChanging] = useState(false);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const read = useRef(getBoard);
  read.current = getBoard;
  const latest = useRef(0);
  const pending = useRef(false);
  const active = useRef(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const refresh = useCallback(async (background = false, fresh = true) => {
    if (!active.current || (pending.current && background)) return;
    const request = ++latest.current;
    pending.current = true;
    if (!background) setLoading(true);
    try {
      const next = await read.current(fresh ? { fresh: true } : {});
      if (active.current && request === latest.current) {
        setSnapshot(next);
        publishDecisionCount(host.id, decisionCount(next));
        setError(null);
        setUpdatedAt(new Date());
      }
    } catch (e) {
      if (active.current && request === latest.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (active.current && request === latest.current) {
        pending.current = false;
        setLoading(false);
      }
    }
  }, [host.id]);

  useEffect(() => {
    active.current = true;
    void refresh(false, false);
    const initial = latest.current;
    // Existing installations may briefly have the old server bundle. The full
    // snapshot still follows its normal path if early readiness is unavailable.
    void readyRef.current({}).then(value => {
      if (active.current && latest.current === initial) setReadiness(value);
    }).catch(() => {});
    const timer = setInterval(() => void refresh(true, false), 30_000);
    return () => { clearInterval(timer); active.current = false; latest.current++; };
  }, [refresh]);

  async function updateScope(input: z.input<typeof boardScope.input>) {
    setChanging(true); setScopeError(null);
    try { await configure(input); setSnapshot(null); setReadiness(null); setEditing(null); await refresh(); }
    catch (e) { setScopeError(e instanceof Error ? e.message : String(e)); }
    finally { setChanging(false); }
  }

  const onSave = async (input: NoteInput) => {
    const result = await save(input);
    await refresh();
    return result;
  };
  const session = editing && snapshot?.sessions.find((row) => row.id === editing);
  return <>
    <BoardView hostId={host.id} hostLabel={host.label} onOpenHostSession={navigation ? (serverId, agentId) => navigation.openAgent({ serverId, agentId }) : undefined} layout={layout} theme={theme} snapshot={snapshot} readiness={readiness} loading={loading} updatedAt={updatedAt} error={scopeError || error}
      changing={changing} coordinator={snapshot?.coordinator}
      onProject={(projectId, enabled) => void updateScope({kind: "project", projectId, enabled})}
      onCoordinator={sessionId => void updateScope({kind: "coordinator", sessionId})}
      onRefresh={() => void refresh()} onOpen={navigation ? (id) => navigation.openAgent({ agentId: id, serverId: host.id }) : undefined} onEdit={setEditing} />
    {session && <NoteEditor key={session.id} session={session} note={snapshot?.notes[session.id]} theme={theme}
      onClose={() => setEditing(null)} onSave={onSave}
      onSetReporting={async (enabled) => { const result = await changeReporting({ sessionId: session.id, enabled }); await refresh(); return result.ok; }} />}
  </>;
}

function BoardScreen(props: PluginScreenProps) {
  return <BoardLanguageProvider key={props.host.id}><HostBoard {...props} /></BoardLanguageProvider>;
}

const boardTitle = "세션별 코디네이터 보드";
const englishBoardTitle = "Session Coordinator Board";

function LocalSidebarItem({ host, theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { language, t } = useBoardLanguage();
  useQuotaNotices(host.id, currentScreen?.screenId !== "board");
  return <SidebarRow icon="LayoutDashboard" label={t(boardTitle, englishBoardTitle)} active={currentScreen?.screenId === "board"}
    trailing={<DecisionBadge key={host.id} host={host.id} theme={theme} />}
    onPress={() => openScreen({ screenId: "board", params: { language } })} />;
}

function SidebarItem(props: PluginSidebarItemProps) {
  return <BoardLanguageProvider><LocalSidebarItem {...props} /></BoardLanguageProvider>;
}

export default function contribute(client: PluginClientContext): () => void {
  const removeScreen = client.addScreen({ id: "board", title: params => params.language === "en" ? englishBoardTitle : boardTitle, Component: BoardScreen });
  const removeSidebarItem = client.addSidebarHeaderItem({ id: "board", title: boardTitle, Component: SidebarItem });
  const removePhotoRenderer = client.addTimelineRenderer({
    kind: "session-photos", version: 1, schema: boardPhotoMessageSchema, Component: SessionPhotoMessage,
  });
  const removePhotoTransformer = client.addTimelineTransformer({
    id: "session-photos", query: { itemType: "user_message" },
    transform({ item }) {
      const messageId = item.clientMessageId ?? item.messageId;
      if (!messageId || !isBoardPhotoMessage(messageId)) return;
      return { items: [{ type: "plugin", kind: "session-photos", version: 1, data: { messageId, text: item.text } }] };
    },
  });
  return () => {
    removePhotoTransformer();
    removePhotoRenderer();
    removeSidebarItem();
    removeScreen();
  };
}
