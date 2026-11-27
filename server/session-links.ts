import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { SessionRow } from "../shared/contract";
import { linkSession, listSessionLinks, type SessionLink } from "../shared/session-links";
import { discoverSessions } from "./discovery";
import { isManagedCoordinator, setCoordinator, type Preferences, type PreferenceStore } from "./preferences";

type Scope = Pick<Preferences, "projects" | "sessionLinks">;

function membership(row: SessionRow, scope: Scope) {
  const source = row.sourceProjectId ?? row.projectId;
  const link = scope.sessionLinks?.[row.id];
  if (link?.sourceProjectId === source && scope.projects.includes(link.targetProjectId)) return link.targetProjectId;
  return scope.projects.includes(source) ? source : null;
}

export function isCurrentMembership(row: SessionRow, scope: Scope) {
  return row.projectId === membership(row, scope);
}

// Rows returned by discoverSessions carry Paseo placement. Only the view adopts a board project.
export function managedSessions(rows: SessionRow[], scope: Scope, titles?: ReadonlyMap<string, string>) {
  return rows.flatMap(row => {
    const projectId = membership(row, scope);
    if (!projectId) return [];
    if (projectId === row.projectId) return [row];
    const link = scope.sessionLinks[row.id];
    return [{ ...row, sourceProjectId: row.projectId, sourceProjectTitle: row.projectTitle,
      projectId, projectTitle: titles?.get(projectId) || link.targetProjectTitle }];
  });
}

export function releaseUnmanagedCoordinator(rows: SessionRow[], scope: Preferences) {
  if (scope.coordinator && !isManagedCoordinator(scope, scope.coordinator) && !managedSessions(rows, scope).some(r => r.id === scope.coordinator)) {
    setCoordinator(scope, null);
  }
}

export function registerSessionLinks(server: PluginServerContext, store: PreferenceStore) {
  server.handle(listSessionLinks, async (_input, { paseo }) => {
    const rows = await discoverSessions(paseo);
    const links = store.read().sessionLinks;
    const directory = new Map(rows.map(r => [r.id, {
      sessionId: r.id, title: r.title, sourceProjectId: r.projectId, sourceProjectTitle: r.projectTitle,
      workspaceTitle: r.workspaceTitle, targetProjectId: links[r.id]?.sourceProjectId === r.projectId ? links[r.id].targetProjectId : null,
      available: true,
    }]));
    for (const link of Object.values(links)) {
      if (directory.get(link.sessionId)?.sourceProjectId !== link.sourceProjectId) directory.set(link.sessionId, { ...link, available: false });
    }
    return { sessions: [...directory.values()] };
  });
  server.handle(linkSession, async (input, { paseo }) => {
    const rows = await discoverSessions(paseo);
    const source = rows.find(row => row.id === input.sessionId && row.projectId === input.sourceProjectId);
    let link: SessionLink | null = null;
    if (input.targetProjectId !== null) {
      if (!source || input.targetProjectId === input.sourceProjectId) throw Error("원래 소속과 다른 관리 프로젝트 및 현재 사용 가능한 원래 세션을 선택하세요.");
      const projects = (await paseo.projects.list()).projects;
      const target = projects.find(p => p.projectId === input.targetProjectId);
      if (!target) throw Error("연결할 프로젝트가 이 호스트에 없습니다.");
      link = {
        sessionId: source.id, sourceProjectId: source.projectId, sourceProjectTitle: source.projectTitle,
        title: source.title, workspaceTitle: source.workspaceTitle,
        targetProjectId: target.projectId, targetProjectTitle: target.projectCustomName || target.projectDisplayName,
      };
    }
    store.change(scope => {
      const existing = scope.sessionLinks[input.sessionId];
      if ((existing?.targetProjectId ?? null) !== input.expectedTargetProjectId || (existing && existing.sourceProjectId !== input.sourceProjectId)) {
        throw Error("세션 연결이 바뀌었습니다. 목록을 새로 고쳐 주세요.");
      }
      if (link) {
        if (!scope.projects.includes(link.targetProjectId)) throw Error("대상 프로젝트를 관리 대상으로 먼저 선택하세요.");
        scope.sessionLinks[input.sessionId] = link;
      } else {
        delete scope.sessionLinks[input.sessionId];
      }
      if ((existing?.targetProjectId ?? null) !== input.targetProjectId) {
        if (scope.factCycle) delete scope.factCycle.candidates[input.sessionId];
        delete scope.judgments[input.sessionId];
        delete scope.supersededAgentNotes[input.sessionId];
        if (scope.coordinator === input.sessionId) releaseUnmanagedCoordinator(rows, scope);
      }
    });
    return { ok: true as const };
  });
}
