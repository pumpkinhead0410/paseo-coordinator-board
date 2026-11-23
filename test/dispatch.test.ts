import assert from "node:assert/strict";
import { test } from "bun:test";
import { createPaseoApi } from "@getpaseo/client";
import { dispatchWorker as dispatchWithRouter, readCatalog, readManagedWorkspaces } from "../server/dispatch";
import { legacyRouter } from "./legacy-router";
import { effectiveWorkerMode, resolveRoute, validateCandidates, type CatalogModel, type DispatchInput, type RouteChoice } from "../shared/dispatch";

// 호스트 Selector 대신 업스트림 추천표로 판정하는 가짜 Router를 주입한다.
const dispatchWorker: typeof dispatchWithRouter = (paseo, request, scope) => dispatchWithRouter(paseo, request, scope, legacyRouter());
const gemini: RouteChoice = { provider: "cursor", model: "gemini-4-neon-high", effort: null };
const sol: RouteChoice = { provider: "codex", model: "gpt-6.2-sol", effort: "high" };
const models: CatalogModel[] = [
  { ...gemini, label: "Gemini", efforts: [], isDefault: true },
  { ...sol, label: "Sol", efforts: ["low", "high"], isDefault: true },
];

test("개인 배정표의 우선·예비·필수 훅을 같은 순서로 판정하고 사라진 모델로 조용히 배정하지 않는다", () => {
  const policy = { C: [gemini, sol] };
  assert.deepEqual(resolveRoute("C", policy, models), gemini);
  assert.deepEqual(resolveRoute("C", policy, models, true), sol);
  assert.deepEqual(resolveRoute("C", policy, models.slice(1)), sol);
  assert.equal(resolveRoute("C", { C: [gemini] }, models.slice(1)), null);
  assert.equal(resolveRoute("M", {}, [models[0]]), null);
  assert.throws(() => validateCandidates("M", [gemini], models), /등급/);
  for (const grade of ["A", "B"] as const) validateCandidates(grade, [gemini], models);
  assert.throws(() => validateCandidates("C", [gemini, gemini], models), /두 번/);
  assert.throws(() => validateCandidates("C", [{ ...gemini, effort: "high" }], models), /추론 강도/);
  assert.deepEqual(resolveRoute("M", {}, models), sol);
  const astro = { provider: "codex", model: "gpt-6.2-astra", label: "Astra", efforts: ["high", "xhigh"], isDefault: false };
  assert.equal(resolveRoute("A", {}, [...models, astro])?.effort, "xhigh");
  assert.equal(resolveRoute("B", {}, [...models, astro])?.effort, "high");
  assert.equal(resolveRoute("D", {}, []), null);
});

test("Claude-only and Codex-only hosts keep their own live models at every grade", () => {
  const opus = { provider: "claude", model: "claude-opus-5-5", label: "Opus", efforts: ["high", "xhigh", "max"], isDefault: true };
  const astra = { provider: "codex", model: "gpt-6.2-astra", label: "Astra", efforts: ["high", "xhigh"], isDefault: false };
  for (const grade of ["A", "B", "C", "D", "M"] as const) {
    assert.equal(resolveRoute(grade, {}, [opus])?.provider, "claude");
    assert.equal(resolveRoute(grade, {}, [astra, models[1]])?.provider, "codex");
    assert.equal(resolveRoute(grade, {}, []), null);
  }
  assert.deepEqual(resolveRoute("A", {}, [models[0], astra, opus]), {provider:"claude", model:opus.model, effort:"max"});
  assert.deepEqual(resolveRoute("B", {}, [models[0], astra, opus]), {provider:"claude", model:opus.model, effort:"xhigh"});
});

test("worker-only hosts cover every grade except the coordinator, and saved A·B routes may use any provider while hooks stay native-only", () => {
  const grok = {...models[0], provider:"grok", model:"grok-latest"};
  const custom = {...models[0], provider:"claude-looking-alias", model:"vendor/model"};
  for (const worker of [models[0], grok, custom]) {
    const choice = {provider:worker.provider, model:worker.model, effort:null};
    for (const grade of ["A", "B", "C", "D"] as const) {
      assert.deepEqual(resolveRoute(grade, {}, [worker]), choice);
      validateCandidates(grade, [choice], [worker]);
      assert.equal(resolveRoute(grade, {}, [worker], true), null);
      assert.equal(resolveRoute(grade, {[grade]:[sol]}, [worker]), null);
    }
    assert.equal(resolveRoute("M", {}, [worker]), null);
    const mixed = [worker, models[1]];
    for (const grade of ["A", "B"] as const) {
      // A·B는 더 이상 claude·codex로 제한하지 않는다. 저장 순서에서 어느 실행기든 고를 수 있다.
      validateCandidates(grade, [choice], mixed);
      validateCandidates(grade, [choice, sol], mixed, [choice]);
      assert.deepEqual(resolveRoute(grade, {[grade]:[choice, sol]}, mixed), choice);
    }
  }
  assert.equal(resolveRoute("C", {}, [grok, custom])?.provider, custom.provider);
});

test("AGY 작업자는 provider 기본값(full-access)이 아니라 auto로 만들고, 사용자 재정의가 우선한다", () => {
  assert.equal(effectiveWorkerMode("antigravity"), "auto");
  assert.equal(effectiveWorkerMode("antigravity", { antigravity: "default" }), "default");
  assert.equal(effectiveWorkerMode("claude"), "auto");
  assert.equal(effectiveWorkerMode("codex"), "auto-review");
});

type DaemonClient = Parameters<typeof createPaseoApi>[0];
type Create = Parameters<DaemonClient["createAgent"]>[0];
const workspace = { id: "space-1", projectId: "project-1", name: "main", workspaceDirectory: "/tmp/synthetic-project" };
const state = { excludedProviders: [], projects: [workspace.projectId], coordinator: "coord", routing: { C: [gemini, sol] } };
const task: DispatchInput = {
  projectId: workspace.projectId, workspaceId: workspace.id, grade: "C", requestKey: "request-dispatch-01",
  title: "문서 교정", prompt: "오탈자를 확인해 줘.", expectedRoute: gemini,
};

function host() {
  const agents = new Map<string, { id: string; workspaceId: string; metadata: Create["metadata"]; currentModeId?: string }>();
  const reqs: Create[] = [];
  const submitted: Create[] = [];
  const daemon = {
    async listAvailableProviders() {
      return { providers: ["cursor", "codex", "offline"].map(provider => ({ provider, available: provider !== "offline" })) };
    },
    async listProviderModes() { return { modes: [{id: "auto-review", label: "Auto-review"}] }; },
    async listProviderModels(provider: string) {
      assert.notEqual(provider, "offline");
      const def = models.find(m => m.provider === provider)!;
      return { models: [{ id: def.model, label: def.label, isDefault: true, thinkingOptions: [{ id: "high" }] }, { id: "legacy", isSelectable: false }] };
    },
    getLastServerInfoMessage: () => ({ serverId: "this-host" }),
    findWorkspace: async (id: string) => id === workspace.id ? workspace : null,
    fetchAgent: async ({ agentId }: { agentId: string }) => agents.has(agentId) ? { agent: agents.get(agentId) } : null,
    async createAgent(req: Create) {
      submitted.push(req);
      const id = req.agentId!;
      const previous = agents.get(id);
      if (previous) {
        assert.deepEqual(reqs.find(first => first.idempotencyKey === req.idempotencyKey), req);
        return previous;
      }
      reqs.push(req);
      const agent = { id, workspaceId: req.workspaceId!, metadata: req.metadata, currentModeId: req.config.modeId };
      agents.set(id, agent);
      return agent;
    },
  };
  // Run the SDK's local parent, provider/model and prompt mapping against an in-memory daemon.
  return { sdk: createPaseoApi(daemon as unknown as DaemonClient), reqs, submitted, daemon };
}

test("SDK가 현재 기기의 워크스페이스에 첫 작업 지시를 보내고 지정한 코디네이터를 부모로 기록한다", async () => {
  const { sdk, reqs, submitted } = host();
  const catalog = await readCatalog(sdk);
  assert.deepEqual(catalog.map(m => [m.provider, m.model, m.efforts]), [
    ["cursor", gemini.model, []], ["codex", sol.model, ["high"]],
  ]);
  const result = await dispatchWorker(sdk, task, () => state);
  const call = reqs[0];
  assert.equal(call.workspaceId, workspace.id);
  assert.equal(call.config.cwd, workspace.workspaceDirectory);
  assert.equal(call.config.provider, "cursor");
  assert.equal(call.config.model, gemini.model);
  assert.equal(call.config.thinkingOptionId, undefined);
  assert.equal(call.initialPrompt, task.prompt);
  assert.equal(call.config.title, task.title);
  assert.equal(call.metadata?.["coordinator-board/reports"], true);
  assert.equal(call.callerAgentId, state.coordinator);
  assert.equal(call.metadata?.["coordinator-board/dispatch-parent"], state.coordinator);
  assert.equal(result.sessionId, call.agentId);
  assert.equal(typeof call.clientMessageId, "string");
  await assert.rejects(dispatchWorker(sdk, { ...task, prompt: "다른 작업" }, () => state), /다른 작업/);
  assert.deepEqual(await dispatchWorker(sdk, task, () => ({ ...state, coordinator: "replacement" })), result);
  assert.equal(reqs.length, 1);
  assert.equal(submitted.length, 2);
});

test("정책·관리 범위가 달라지거나 다른 워크스페이스면 생성하지 않고, 필수 훅은 native 모델로만 시작한다", async () => {
  const { sdk, reqs } = host();
  const other = { ...state, projects: ["other"] };
  const staleTask = { ...task, targetServerId: "stale-selection" };
  await assert.rejects(dispatchWorker(sdk, staleTask, () => state), /targetServerId/);
  await assert.rejects(dispatchWorker(sdk, task, () => ({ ...state, coordinator: null })), /코디네이터/);
  await assert.rejects(dispatchWorker(sdk, task, () => other), /관리할 프로젝트/);
  await assert.rejects(dispatchWorker(sdk, { ...task, workspaceId: "foreign" }, () => state), /워크스페이스/);
  await assert.rejects(dispatchWorker(sdk, { ...task, projectId: "other" }, () => other), /워크스페이스/);
  await assert.rejects(dispatchWorker(sdk, { ...task, needsHooks: true }, () => state), /plan_board_assignment/);
  let reads = 0;
  await assert.rejects(dispatchWorker(sdk, task, () => ++reads === 1 ? state : other), /관리할 프로젝트/);
  assert.equal(reqs.length, 0);
  await dispatchWorker(sdk, { ...task, needsHooks: true, expectedRoute: sol }, () => ({ ...state, coordinator: "local-coord" }));
  assert.equal(reqs[0].config.thinkingOptionId, "high");
  assert.equal(reqs[0].config.modeId, "auto-review");
  assert.equal(reqs[0].callerAgentId, "local-coord");
});

test("검증되지 않은 생성 모드는 완료로 보고하지 않고, 재시도할 때 같은 세션을 확인한다", async () => {
  const { sdk, daemon, reqs } = host();
  const fetchAgent = daemon.fetchAgent;
  daemon.fetchAgent = async input => {
    const result = await fetchAgent(input);
    return result ? { agent: { ...result.agent, currentModeId: "default" } } : null;
  };
  const request = { ...task, needsHooks:true, expectedRoute:sol };
  await assert.rejects(dispatchWorker(sdk, request, () => state), /만들었지만.*auto-review/);
  await assert.rejects(dispatchWorker(sdk, request, () => state), /만들었지만.*auto-review/);
  assert.equal(reqs.length, 1);
});

test("권한 지정 전 버전이 생성한 작업은 최초 페이로드 그대로 재확인한다", async () => {
  const { sdk, reqs, submitted } = host();
  const request = { ...task, needsHooks:true, expectedRoute:sol };
  await dispatchWorker(sdk, request, () => state);
  const original = reqs[0];
  delete original.metadata!["coordinator-board/dispatch-mode"];
  delete original.config.modeId;
  const replay = await dispatchWorker(sdk, request, () => state);
  assert.equal(replay.sessionId, original.agentId);
  assert.equal("modeId" in replay, false);
  assert.equal(reqs.length, 1);
  assert.equal(submitted.length, 2);
});

test("직접 저장한 실행기 기본 강도를 보존하고 추천 목록 밖의 기본 모델은 지원되는 high를 고른다", () => {
  const model = {...models[1],provider:"codex",model:"new-default",efforts:["low","high"],isDefault:true};
  assert.equal(resolveRoute("C", {}, [model])?.effort, "high");
  const saved = { provider:"codex",model:model.model, effort:null };
  assert.equal(resolveRoute("C", { C:[saved] }, [model])?.effort, null);
});

test("워크스페이스 목록은 페이지를 넘겨 관리 프로젝트의 준비된 작업 위치만 표시한다", async () => {
  const calls: (string | undefined)[] = [];
  const sdk = { workspaces: { list: async ({ page }: { page: { cursor?: string } }) => {
    calls.push(page.cursor);
    return page.cursor ? { entries: [{ ...workspace, title: "선택 가능" }], pageInfo: { hasMore: false, nextCursor: null } } :
      { entries: [{ ...workspace, id: "other", projectId: "other" }, { ...workspace, internal: true }, { ...workspace, setupStatus: "failed" }, { ...workspace, archivingAt: "now" }],
        pageInfo: { hasMore: true, nextCursor: "page-2" } };
  } } } as unknown as Parameters<typeof readManagedWorkspaces>[0];
  assert.deepEqual(await readManagedWorkspaces(sdk, []), []);
  assert.deepEqual(await readManagedWorkspaces(sdk, [workspace.projectId]), [{ id: workspace.id, projectId: workspace.projectId, title: "선택 가능" }]);
  assert.deepEqual(calls, [undefined, "page-2"]);
});

test("생성 결과를 잃은 뒤 세션 행만 보고 성공 처리하지 않고 같은 데몬 영수증을 다시 조회한다", async () => {
  const { sdk, daemon, reqs, submitted } = host();
  const create = daemon.createAgent;
  let reconcile = false;
  daemon.createAgent = async req => {
    const result = await create(req);
    if (!reconcile) throw new Error("첫 프롬프트 전송 확인 중 연결 끊김");
    return result;
  };
  await assert.rejects(dispatchWorker(sdk, task, () => state), /연결 끊김/);
  await assert.rejects(dispatchWorker(sdk, task, () => state), /연결 끊김/);
  reconcile = true;
  const result = await dispatchWorker(sdk, task, () => state);
  assert.equal(result.sessionId, reqs[0].agentId);
  assert.equal(reqs.length, 1);
  assert.equal(submitted.length, 3);
});

test("동시에 온 같은 요청은 한 작업과 첫 메시지에 연결된다", async () => {
  const { sdk, reqs, submitted } = host();
  const [a, b] = await Promise.all([
    dispatchWorker(sdk, task, () => state), dispatchWorker(sdk, task, () => state),
  ]);
  assert.deepEqual(a, b);
  assert.equal(reqs.length, 1);
  assert.equal(submitted.length, 2);
});

test("일부 모델 목록 장애는 다른 실행기를 막지 않고 전체 조회 장애를 모델 0개로 위장하지 않는다", async () => {
  const { sdk, daemon } = host();
  const list = daemon.listProviderModels;
  daemon.listProviderModels = async provider => {
    if (provider === "cursor") throw new Error("synthetic account diagnostic");
    return list(provider);
  };
  assert.deepEqual((await readCatalog(sdk)).map(m => m.provider), ["codex"]);
  daemon.listProviderModels = async () => { throw new Error("synthetic account diagnostic"); };
  await assert.rejects(readCatalog(sdk), /연결을 확인/);
});
