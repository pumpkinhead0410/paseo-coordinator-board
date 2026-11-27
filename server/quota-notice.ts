import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { displayLane } from "../shared/decision-count";
import type { SessionRow } from "../shared/contract";
import { basename } from "node:path";
import type { ConversationReader } from "./conversation";
import { discoverSessions } from "./discovery";
import type { NoteStore } from "./notes";
import type { PreferenceStore } from "./preferences";
import { isCurrentMembership, managedSessions } from "./session-links";

type Sdk = PluginHandlerContext["paseo"];
type Timeline = Awaited<ReturnType<ReturnType<Sdk["agents"]["ref"]>["timeline"]["refetch"]>>;

// Antigravity projects its own warning as assistant text. Require its entire
// terminal message; a quoted error in an assignment or progress report is common.
const individual = /^⚠\s*Individual quota reached\.(?: Please upgrade your subscription to increase your limits\.)?(?: Resets in ((?=\d)(?:(\d{1,3})h)?(?:(\d{1,2})m)?(?:(\d{1,2})s)?)\.)?$/;
const nativeError = /^(?:Individual quota reached|Usage limit reached|You(?:'|’)ve hit your usage limit|insufficient_quota)(?:[.:!\s]|$)/i;

export function quotaEvidence(page: Timeline) {
  const end = page.entries.at(-1);
  if (!end) return;
  const item = end.item;
  const match = item.type === "assistant_message" && individual.exec(item.text.trim());
  const error = item.type === "error" && nativeError.test(item.message.trim());
  if (!match && !error) return;
  const lastInput = page.entries.findLast(({ item }) => item.type === "user_message")?.item;
  if (match && lastInput?.type === "user_message" && lastInput.text.includes(match[0])) return;
  const at = Date.parse(end.timestamp);
  let reset = "미확인";
  if (match && match[1]) {
    const ms = ((Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 60 + Number(match[4] || 0)) * 1000;
    reset = `경고 시점에서 ${match[1]} 후` + (Number.isFinite(at) ? ` (예상 ${new Date(at + ms).toISOString()})` : "");
  }
  if (item.type === "error") {
    // Preserve the provider's clock and zone, including a missing zone.
    reset = /\b(?:try again|resets?) at ([^\n]{1,100}?)[.!]?$/i.exec(item.message.trim())?.[1] ?? reset;
  }
  let step = "미확인", commit = "미확인";
  for (const { item, turnId } of page.entries.slice(0, -1).reverse()) {
    if ((turnId && end.turnId && turnId !== end.turnId) || item.type === "user_message") break;
    if (item.type !== "tool_call" || item.status !== "completed") continue;
    const d = item.detail;
    if (step === "미확인") step = d && "filePath" in d ? `${item.name} · ${basename(d.filePath)}` : item.name;
    if (d?.type === "shell" && d.exitCode === 0 && /^git (?:commit\b|rev-parse HEAD$)/.test(d.command)) {
      const sha = /^\[[^\]\n]+ ([0-9a-f]{7,40})\] /m.exec(d.output ?? "")?.[1] ?? /^([0-9a-f]{40})$/.exec(d.output?.trim() ?? "")?.[1];
      if (sha) { commit = sha; break; }
    }
  }
  const key = end.turnId ? JSON.stringify(["turn", end.turnId]) : JSON.stringify([end.timestamp,
    item.type === "assistant_message" && item.messageId ? item.messageId : end.seqEnd]);
  return { key, reset, step, commit, antigravity: !!match };
}

function stopped(row: SessionRow) {
  return !row.hasActiveTurn && !row.nativePending && row.lane !== "running" && (row.status === "error" || row.status === "idle");
}

export async function claimQuotaNotice(paseo: Sdk, prefs: PreferenceStore, notes: NoteStore, reader: ConversationReader) {
  if (!prefs.read().projects.length) return null;
  const placementsAtStart = await discoverSessions(paseo);
  const scope = prefs.read();
  const rows = managedSessions(placementsAtStart, scope);
  for (const row of rows) {
    if (!stopped(row)) continue;
    const evidence = await reader.read(paseo, row).catch(() => null);
    const event = evidence?.quota;
    if (!event || (event.antigravity && row.provider !== "antigravity")) continue;
    if (scope.quotaReceipts[row.id] === event.key) continue;
    const placements = await discoverSessions(paseo);
    const current = prefs.read();
    const latest = managedSessions(placements, current);
    const source = latest.find(candidate => candidate.id === row.id);
    if (!source || !stopped(source) || source.activityAt !== row.activityAt || source.projectId !== row.projectId) continue;
    if (!isCurrentMembership(row, current) || current.quotaReceipts[row.id] === event.key) continue;
    const note = notes.visible(new Set([row.id]))[row.id];
    if (displayLane({ ...source, evidenceId: evidence.id }, note) === "done") continue;
    const other = latest.find(r => r.id !== row.id && r.projectId === row.projectId && r.status === "idle" && r.lane === "idle" &&
      r.provider && r.provider !== row.provider && !current.excludedProviders.includes(r.provider));
    prefs.change(s => { s.quotaReceipts[row.id] = event.key; });
    const target = other ? `관리 세션 후보 ${other.title} (${other.id}), 수임 가능 여부 미확인` : "대체 세션 미확인";
    return `사용량 한도로 중단 · ${row.projectTitle} / ${row.title} (${row.id})\n마지막 확인 작업: ${event.step} · 커밋: ${event.commit}\n${row.provider ?? "제공자"} 회복: ${event.reset}\n${target}. 인계 또는 회복 대기를 선택하세요.`;
  }
  return null;
}
