import { createHash } from "node:crypto";
import { readPages } from "../shared/pages";
export { readPages } from "../shared/pages";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { reportingKey, type SessionRow } from "../shared/contract";

import { githubRepository } from "../shared/github-repository";
import { workspacePull } from "../shared/workspace-pull";

type Sdk = PluginHandlerContext["paseo"];
type AgentPage = Awaited<ReturnType<Sdk["agents"]["list"]>>;
type Entry = AgentPage["entries"][number];
type WorkspacePage = Awaited<ReturnType<Sdk["workspaces"]["list"]>>;
type Workspace = WorkspacePage["entries"][number];

// Only foreground coordinators with native mid-turn input can accept another
// card immediately. Other providers and ordinary workers wait for idle.
export function canReceiveBoardInput(agent:Pick<Entry["agent"],"status"|"activeTurn"|"pendingPermissions"|"attentionReason"|"provider">, coordinator:boolean) {
  if (agent.pendingPermissions.length || agent.attentionReason==="permission" || agent.attentionReason==="error") return false;
  if (agent.status==="idle" && !agent.activeTurn) return true;
  return coordinator && agent.status==="running" && !!agent.activeTurn && (agent.provider==="claude" || agent.provider==="codex");
}

export function permissionVersion(agent: Entry["agent"]) {
  const requests = agent.pendingPermissions.map(p => [p.id, p.title, p.name, p.description]);
  if (!requests.length && (agent.attentionReason !== "permission" || !agent.updatedAt)) return undefined;
  return createHash("sha256").update(JSON.stringify(requests.length ? requests : agent.updatedAt)).digest("hex");
}

function observedState(agent: Entry["agent"]): Pick<SessionRow, "lane" | "detail" | "nativePending"> {
  const pending = agent.pendingPermissions.length;
  if (pending) {
    const labels = agent.pendingPermissions.map(p => p.title || p.name).filter(Boolean);
    const detail = [`응답을 기다리는 요청 ${pending}건`, ...labels].join(" · ").slice(0, 2000);
    return { lane: "human", nativePending: true, detail };
  }
  if (agent.attentionReason === "permission") return { lane: "human", nativePending: true, detail: "세션에서 응답 요청 확인" };
  if (agent.status === "error" || agent.attentionReason === "error") {
    return { lane: "review", detail: "오류 확인 필요" };
  }
  if (agent.status === "running" || agent.activeTurn) return { lane: "running", detail: "작업 중" };
  if (agent.status === "initializing") return { lane: "unknown", detail: "세션을 여는 중" };
  if (agent.lastError) return { lane: "review", detail: "마지막 오류 확인 필요" };
  if (agent.requiresAttention || agent.attentionReason === "finished") {
    return { lane: "review", detail: "세션 결과 확인 필요" };
  }
  if (agent.status === "idle" || agent.status === "closed") {
    const count = agent.backgroundWork?.count ?? 0;
    return { lane: "idle", detail: count ? `대화 대기 · 백그라운드 작업 ${count}개` : agent.status === "idle" ? "다음 요청 대기" : "대화 종료" };
  }
  return { lane: "unknown", detail: "세션 상태 미확인" };
}

export async function discoverSessions(paseo: Pick<Sdk, "agents" | "workspaces">): Promise<SessionRow[]> {
  const [entries, workspaces] = await Promise.all([
    readPages<Entry>((page) => paseo.agents.list({
      filter: { includeArchived: false, includeBackground: true },
      sort: [{ key: "created_at", direction: "asc" }], page,
    })),
    readPages<Workspace>((page) => paseo.workspaces.list({
      filter: { includeBackground: true }, sort: [{ key: "project_id", direction: "asc" }], page,
    })),
  ]);
  const byWorkspace = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const rows = new Map<string, SessionRow>();
  for (const { agent, project } of entries) {
    const workspace = agent.workspaceId ? byWorkspace.get(agent.workspaceId) : undefined;
    if (agent.archivedAt || agent.internal || workspace?.archivingAt) {
      rows.delete(agent.id);
      continue;
    }
    const work = workspace && !workspace.internal ? workspacePull(workspace) : undefined;
    const repo = work?.repo ?? (workspace && !workspace.internal ? githubRepository(workspace.gitRuntime?.remoteUrl) : null);
    const permission = permissionVersion(agent);
    rows.set(agent.id, {
      ...(work ? { workspacePull: work } : {}),
      id: agent.id,
      title: agent.title?.trim() || `세션 ${agent.id.slice(0, 8)}`,
      projectId: workspace?.projectId || project.projectKey || "unassigned",
      projectTitle: workspace?.projectCustomName?.trim() || workspace?.projectDisplayName || project.projectName || "프로젝트 미확인",
      ...(repo ? { projectRepo: repo } : {}),
      ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
      workspaceTitle: workspace?.title?.trim() || workspace?.name || project.workspaceName || "워크스페이스 미확인",
      provider: agent.provider?.trim() || null,
      model: agent.model?.trim() || null,
      ...(agent.metadata?.[reportingKey] === true ? { reporting: true } : {}),
      status: agent.status, activityAt: agent.updatedAt,
      ...observedState(agent),
      ...(agent.attentionReason === "permission" && agent.attentionTimestamp ? {decisionRequestedAt:agent.attentionTimestamp} : {}),
      ...(permission ? { permissionVersion: permission } : {}),
    });
  }
  return [...rows.values()];
}
