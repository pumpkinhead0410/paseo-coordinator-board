import { test } from "node:test";
import assert from "node:assert/strict";
import type { usePaseo } from "@getpaseo/plugin/client";
import { discoverSessions } from "../server/discovery";

type Sdk = ReturnType<typeof usePaseo>;
type Agent = Awaited<ReturnType<Sdk["agents"]["list"]>>["entries"][number]["agent"];
type AgentPatch = Partial<Agent> & Pick<Agent, "id">;
type TestPage<T> = { entries: T[]; pageInfo: { hasMore: boolean; nextCursor: string | null } };

function page<T>(entries: T[], nextCursor: string | null = null): TestPage<T> {
  return { entries, pageInfo: { hasMore: nextCursor !== null, nextCursor } };
}

function entry(agent: AgentPatch, projectKey = "p") {
  return {
    agent: { title: null, model: null, workspaceId: "w", pendingPermissions: [], status: "idle", ...agent },
    project: { projectKey, projectName: "기본 프로젝트", workspaceName: "기본 작업 폴더" },
  };
}

function directory(agents: (...args: any[]) => unknown, workspaces: (...args: any[]) => unknown = () => page([])) {
  // Fixtures implement only the two SDK list methods. Any timeline access or write fails.
  return { agents: { list: agents }, workspaces: { list: workspaces } } as unknown as Sdk;
}

test("각 목록의 모든 페이지를 읽고 이름이 같은 프로젝트와 중복 세션을 구분한다", async () => {
  const calls: string[] = [];
  const workspace = { id: "w", title: "작업 폴더", name: "branch", projectId: "repo", projectDisplayName: "프로젝트", projectCustomName: "내 프로젝트" };
  const sdk = directory((query) => {
    calls.push("agent:" + (query.page.cursor ?? "first"));
    assert.equal(query.filter.includeBackground, true);
    assert.equal(query.filter.includeArchived, false);
    assert.equal(query.sort[0].key, "created_at");
    if (!query.page.cursor) return page([entry({ id: "a", title: "옛 제목" })], "next-a");
    return page([entry({ id: "a", title: "새 제목", model: "observed" }), entry({ id: "b", workspaceId: undefined }, "other")]);
  }, (query) => {
    calls.push("workspace:" + (query.page.cursor ?? "first"));
    assert.equal(query.filter.includeBackground, true);
    return query.page.cursor ? page([workspace]) : page([], "next-w");
  });

  const rows = await discoverSessions(sdk);
  assert.deepEqual(calls.sort(), ["agent:first", "agent:next-a", "workspace:first", "workspace:next-w"]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: "a", title: "새 제목", projectId: "repo", projectTitle: "내 프로젝트", workspaceId: "w", workspaceTitle: "작업 폴더", model: "observed", provider: null, status: "idle", activityAt: undefined, lane: "idle", detail: "다음 요청 대기" });
  assert.equal(rows[1].projectId, "other");
  assert.equal(rows[1].workspaceTitle, "기본 작업 폴더");
  assert.equal(rows[1].model, null);
  assert.equal(rows[1].title, "세션 b");
});

test("출처가 명시된 권한 요청은 러닝보다 우선한다. 오류·읽지 않은 결과·유휴는 사람의 결정과 구분한다", async () => {
  const permissions = [{ id: "local-test" }] as Agent["pendingPermissions"];
  const snapshots: AgentPatch[] = [
    { id: "permission", pendingPermissions: permissions, status: "running" },
    { id: "permission-reason", attentionReason: "permission", status: "running" },
    { id: "running", status: "running", requiresAttention: true },
    { id: "error", status: "error" },
    { id: "previous-error", lastError: "synthetic private detail" },
    { id: "unread", attentionReason: "finished", requiresAttention: true },
    { id: "idle" }, { id: "closed", status: "closed" },
    { id: "background", backgroundWork: { count: 2 } },
    { id: "opening", status: "initializing" },
    { id: "old", archivedAt: "2026-11-01" }, { id: "private-helper", internal: true },
  ];
  const rows = await discoverSessions(directory(() => page(snapshots.map((a) => entry(a)))));
  assert.deepEqual(rows.map((row) => [row.id, row.lane]), [
    ["permission", "human"], ["permission-reason", "human"], ["running", "running"],
    ["error", "review"], ["previous-error", "review"], ["unread", "review"],
    ["idle", "idle"], ["closed", "idle"], ["background", "idle"], ["opening", "unknown"],
  ]);
  assert.match(rows[0].detail, /1건/);
  assert.match(rows[8].detail, /2개/);
  assert.doesNotMatch(JSON.stringify(rows), /synthetic private detail/);
});

test("계속 같은 페이지를 돌려주거나 연결에 실패하면 빈 보드로 숨기지 않는다", async () => {
  await assert.rejects(discoverSessions(directory(() => page([], "same"))), /다음 목록 페이지/);
  await assert.rejects(discoverSessions(directory(() => {
    throw new Error("호스트 연결 끊김");
  })), /호스트 연결 끊김/);
  assert.deepEqual(await discoverSessions(directory(() => page([]))), []);
});

test("보고 도구 활성화는 명시적 true만 인정하고 그 밖의 메타데이터는 내보내지 않는다", async () => {
  const rows = await discoverSessions(directory(() => page([
    entry({ id: "enabled", metadata: { "coordinator-board/reports": true, other: "private metadata" } }),
    entry({ id: "string", metadata: { "coordinator-board/reports": "true" } }),
    entry({ id: "off", metadata: { "coordinator-board/reports": false } }),
  ])));
  assert.deepEqual(rows.map((r) => r.reporting), [true, undefined, undefined]);
  assert.doesNotMatch(JSON.stringify(rows), /private metadata/);
});


test("the observed session provider comes from its snapshot even when the model belongs to another provider family", async () => {
  const rows = await discoverSessions(directory(() => page([
    entry({id:"routed",provider:"my-acp",model:"openai/example-v2"}),
    entry({id:"unknown",model:"openai/example-v2"}),
  ])));
  assert.deepEqual(rows.map(r => r.provider), ["my-acp", null]);
});

test("permission wait starts at the permission attention event, never a later session update", async () => {
  const at = "2026-11-01T00:00:00Z";
  const rows = await discoverSessions(directory(() => page([
    entry({id:"permission",attentionReason:"permission",attentionTimestamp:at,updatedAt:"2026-11-22T05:00:00Z"}),
    entry({id:"finished",attentionReason:"finished",attentionTimestamp:at}),
  ])));
  assert.equal(rows[0].decisionRequestedAt, at);
  assert.equal(rows[1].decisionRequestedAt, undefined);
});
