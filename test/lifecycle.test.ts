import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachCoordinatorTools } from "../server/coordinator";
import { ConversationReader } from "../server/conversation";
import { buildCoordinatorSystemPrompt, CoordinatorLifecycle } from "../server/lifecycle";
import { isManagedCoordinator, PreferenceStore, setCoordinator } from "../server/preferences";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
const start = { expectedCoordinator: null, replace: false, config: { provider: "codex/fixture-model", thinkingOptionId: "high" } };
const decision = { evidenceId: "fixture", kind: "question", text: "언제 공개할까요?", projectId: "team" };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "coordinator-mode-"));
  paths.push(dir);
  const path = join(dir, "scope.json"), directory = join(dir, "operate");
  writeFileSync(path, JSON.stringify({ projects: ["team"], coordinator: null, judgments: { worker: decision } }));
  const prefs = new PreferenceStore(path);
  const lifecycle = new CoordinatorLifecycle(prefs, directory);
  const pages = (entries) => ({ entries, pageInfo: { hasMore: false, nextCursor: null } });
  const agents = new Map(), creations = [];
  const effects = { beforeCreate: async (_id) => {}, afterCreate: async (_id) => {} };
  const pins = { calls: [] as boolean[], pinnedAt: null as string | null, fail: false };
  const workspaceSnapshot = () => ({ id: "operating-workspace", title: "코디네이터 운영", pinnedAt: pins.pinnedAt });
  const ws = {
    id: "operating-workspace", current: workspaceSnapshot, refresh: async () => workspaceSnapshot(), setTitle: async () => {},
    setPinned: async (enabled: boolean) => {
      pins.calls.push(enabled);
      if (pins.fail) throw Error("pin unavailable");
      pins.pinnedAt = enabled ? "2026-11-22T00:00:00Z" : null;
      return { pinnedAt: pins.pinnedAt };
    },
    agents: { create: async input => {
      creations.push(input);
      await effects.beforeCreate(input.agentId);
      agents.set(input.agentId, { id: input.agentId, workspaceId: ws.id, metadata: input.metadata, pendingPermissions: [], status: "idle" });
      await effects.afterCreate(input.agentId);
    } },
  };
  const sdk = {
    workspaces: { ref: id => { expect(id).toBe(ws.id); return ws; }, open: async path => { expect(path).toBe(directory); return ws; }, list: () => pages([]) },
    agents: {
      list: () => pages([...agents.values()].map(agent => ({ agent, project: { projectKey: agent.workspaceId === ws.id ? "operate" : "team" } }))),
      ref: id => ({ refresh: async () => agents.has(id) ? { agent: agents.get(id) } : null }),
    },
  };
  return { path, directory, prefs, lifecycle, sdk, effects, agents, creations, pins, ws };
}

test("신규 설치 두 창이 동시에 시작해도 운영 세션 한 개와 기존 발췌 판단을 유지한다", async () => {
  const f = setup();
  const [first, second] = await Promise.all([f.lifecycle.ensure(f.sdk, start), f.lifecycle.ensure(f.sdk, start)]);
  expect(first.sessionId).toBe(second.sessionId);
  expect(second.reused).toBe(true);
  expect(f.creations).toHaveLength(1);
  expect(f.creations[0]).toMatchObject({ agentId: first.sessionId, idempotencyKey: first.sessionId, config: { ...start.config, systemPrompt: expect.stringContaining("read_board_conversation") } });
  expect(f.creations[0].prompt).toBeUndefined();
  expect(f.creations[0].config.toolPolicy).toBeUndefined();
  expect(f.prefs.read().judgments.worker).toEqual(decision);
  expect(f.prefs.read().routing).toEqual({});
  expect(f.prefs.read().routingRevision).toBe(0);
  f.prefs.change(s => setCoordinator(s, null));
  expect((await f.lifecycle.ensure(f.sdk, start)).sessionId).toBe(first.sessionId);
  expect(f.creations).toHaveLength(1);
});

test("교체 승인 전에는 새 세션이 판단할 수 없고, 성공 뒤에는 원래 코디네이터의 도구 호출을 거절한다", async () => {
  const f = setup();
  f.agents.set("original", { id: "original", workspaceId: "repo", status: "idle", pendingPermissions: [] });
  f.prefs.change(s => setCoordinator(s, "original"));
  let hook;
  attachCoordinatorTools({ addHook: (_, h) => { hook = h; return () => {}; } }, f.prefs, new ConversationReader());
  const open = async id => (await hook({ request: { purpose: "interactive", agentId: id, tools: [] } })).tools[0];
  const call = async (tool, id) => JSON.parse((await tool.execute({}, { paseo: f.sdk, agent: { id } })).text);
  const original = await open("original");
  let stagedTool;
  f.effects.beforeCreate = async id => {
    stagedTool = await open(id);
    await expect(call(stagedTool, id)).rejects.toThrow("해제");
    expect(await call(original, "original")).toHaveLength(1);
  };
  const replacement = { ...start, expectedCoordinator: "original", replace: true };
  const next = await f.lifecycle.ensure(f.sdk, replacement);
  expect(isManagedCoordinator(f.prefs.read(), next.sessionId)).toBe(true);
  expect((await call(stagedTool, next.sessionId)).map(r => r.id)).toEqual(["original"]);
  await expect(call(original, "original")).rejects.toThrow("해제");
  expect(f.prefs.read().judgments.worker).toEqual(decision);
  expect((await f.lifecycle.ensure(f.sdk, replacement)).sessionId).toBe(next.sessionId);
  expect(f.creations).toHaveLength(1);
});

test("생성 응답이 끊겨도 이전 코디네이터를 유지하고 재시작 후 같은 ID를 찾아 전환한다", async () => {
  const f = setup();
  f.prefs.change(s => setCoordinator(s, "old"));
  const input = { ...start, expectedCoordinator: "old", replace: true };
  f.effects.afterCreate = async () => { throw Error("연결이 끊겼습니다"); };
  await expect(f.lifecycle.ensure(f.sdk, input)).rejects.toThrow("연결");
  expect(f.prefs.read().coordinator).toBe("old");
  expect(f.prefs.read().judgments.worker).toEqual(decision);
  const restored = new CoordinatorLifecycle(new PreferenceStore(f.path), f.directory);
  expect((await restored.ensure(f.sdk, input)).sessionId).toBe(f.creations[0].agentId);
  expect(f.creations).toHaveLength(1);
});

test("교체 도중 사용자가 다른 담당자를 지목하면 오래된 생성 결과가 그 선택을 덮지 않는다", async () => {
  const f = setup();
  f.effects.afterCreate = async () => { f.prefs.change(s => setCoordinator(s, "chosen-by-person")); };
  await expect(f.lifecycle.ensure(f.sdk, start)).rejects.toThrow("바뀌");
  expect(f.prefs.read().coordinator).toBe("chosen-by-person");
  expect(f.prefs.read().judgments.worker).toEqual(decision);
  await expect(f.lifecycle.ensure(f.sdk, start)).rejects.toThrow("바뀌");
  expect(f.creations).toHaveLength(1);
});

test("현재 호스트에서 선택한 프로젝트가 없거나 교체 중 마지막 프로젝트가 제외되면 코디네이터를 지정하지 않는다", async () => {
  const f = setup();
  f.prefs.change(s => { s.projects = []; });
  await expect(f.lifecycle.ensure(f.sdk, start)).rejects.toThrow("프로젝트");
  expect(f.creations).toHaveLength(0);
  f.prefs.change(s => { s.projects = ["team"]; });
  f.effects.afterCreate = async () => { f.prefs.change(s => { s.projects = []; }); };
  await expect(f.lifecycle.ensure(f.sdk, start)).rejects.toThrow("바뀌");
  expect(f.prefs.read().coordinator).toBe(null);
});

test("운영 공간을 여는 동안 실행기를 제외하면 새 운영 세션을 띄우지 않는다", async () => {
  const f = setup();
  const open = f.sdk.workspaces.open;
  f.sdk.workspaces.open = async path => {
    f.prefs.change(s => { s.excludedProviders = ["codex"]; });
    return open(path);
  };
  await expect(f.lifecycle.ensure(f.sdk, {
    ...start, verifyRoute: scope => {
      if (scope.excludedProviders.includes("codex")) throw new Error("실행기 제외");
    },
  })).rejects.toThrow(/제외/);
  expect(f.creations).toHaveLength(0);
  expect(f.prefs.read().coordinator).toBeNull();
});

test("준비한 새 세션이 다른 권한을 보고하면 기존 운영 세션을 유지한다", async () => {
  const f = setup();
  f.prefs.change(s => { s.coordinator = "old"; });
  f.effects.afterCreate = async id => { f.agents.get(id).currentModeId = "default"; };
  const change = {...start, expectedCoordinator:"old", replace:true, config:{...start.config, modeId:"auto-review"}};
  await expect(f.lifecycle.ensure(f.sdk,change)).rejects.toThrow(/권한 모드/);
  expect(f.prefs.read().coordinator).toBe("old");
  f.agents.get(f.creations[0].agentId).currentModeId = "auto-review";
  expect((await f.lifecycle.ensure(f.sdk,change)).sessionId).toBe(f.creations[0].agentId);
  expect(f.creations).toHaveLength(1);
});

test("a new operating workspace is pinned once; reloading, retry and rotation respect a manual unpin", async () => {
  const f = setup();
  expect(f.prefs.read().autoPinCoordinatorWorkspace).toBe(true);
  const first = await f.lifecycle.ensure(f.sdk, start);
  expect(f.pins.calls).toEqual([true]);
  expect(f.pins.pinnedAt).toBeTruthy();
  f.pins.pinnedAt = null;
  const restarted = new CoordinatorLifecycle(new PreferenceStore(f.path), f.directory);
  await restarted.ensure(f.sdk, start);
  await restarted.ensure(f.sdk, { ...start, replace: true, expectedCoordinator: first.sessionId });
  expect(f.creations).toHaveLength(2);
  expect(f.pins.calls).toEqual([true]);
  expect(f.pins.pinnedAt).toBeNull();
});

test("disabled or already pinned keeps the native workspace pin and its timestamp untouched", async () => {
  for (const alreadyPinned of [true, false]) {
    const f = setup();
    if (alreadyPinned) f.pins.pinnedAt = "initial-pin";
    else f.prefs.change(s => { s.autoPinCoordinatorWorkspace = false; });
    await f.lifecycle.ensure(f.sdk, start);
    expect(f.pins.calls).toEqual([]);
    expect(f.pins.pinnedAt).toBe(alreadyPinned ? "initial-pin" : null);
  }
});

test("pin failure preserves the coordinator; a manual retry only pins the verified current workspace", async () => {
  const f = setup();
  f.pins.fail = true;
  const created = await f.lifecycle.ensure(f.sdk, start);
  expect(created.pinFailed).toBe(true);
  expect(f.prefs.read().coordinator).toBe(created.sessionId);
  f.pins.fail = false;
  const pin = () => f.lifecycle.pinCurrent(f.sdk, created.sessionId, created.workspaceId);
  await expect(f.lifecycle.pinCurrent(f.sdk, "old", created.workspaceId)).rejects.toThrow();
  await expect(f.lifecycle.pinCurrent(f.sdk, created.sessionId, "unrelated")).rejects.toThrow();
  await Promise.all([pin(), pin()]);
  expect(f.pins.calls).toEqual([true, true]);
  expect(f.creations).toHaveLength(1);
  expect((await f.lifecycle.pinSettings(f.sdk)).workspace).toMatchObject({id:created.workspaceId, coordinator:created.sessionId, pinned:true});
  f.pins.pinnedAt = null;
  const refresh = f.ws.refresh;
  f.ws.refresh = async () => { f.prefs.change(s => setCoordinator(s, "later")); return refresh(); };
  await expect(pin()).rejects.toThrow();
  expect(f.pins.calls).toEqual([true, true]);
});

test("코디네이터 세션 생성 시 genui SKILL.md가 있으면 frontmatter를 제외해 systemPrompt에 주입하고, 없으면 기본 charter만 유지한다", async () => {
  const f = setup();
  const skillPath = `${f.path}.genui.md`;
  const missingPath = `${f.path}.missing.md`;
  expect(buildCoordinatorSystemPrompt(missingPath)).not.toContain("[paseo-plugin-genui]");

  // 파일이 비어 있거나 frontmatter만 있어도(빈 frontmatter 포함) 기본 charter만 반환
  writeFileSync(skillPath, "---\nname: genui\n---\n\n");
  expect(buildCoordinatorSystemPrompt(skillPath)).not.toContain("[paseo-plugin-genui]");
  writeFileSync(skillPath, "---\n---\n");
  expect(buildCoordinatorSystemPrompt(skillPath)).not.toContain("[paseo-plugin-genui]");

  // 마커가 없는 SKILL.md에도 중복 방지 마커([paseo-plugin-genui])를 1회 자동 부착
  writeFileSync(skillPath, "---\nname: genui\ndescription: test\n---\n\n# Inline UI\nCard(\"Demo\", [])\n");
  const withMarker = buildCoordinatorSystemPrompt(skillPath);
  expect(withMarker.split("[paseo-plugin-genui]").length - 1).toBe(1);
  expect(withMarker).not.toContain("description: test");
  expect(withMarker).toContain("Card(\"Demo\", [])");

  // 입력에 마커가 중복되어 있어도 정확히 1회만 남기고, 헌장에 genui 메인 전용 안내를 포함
  writeFileSync(skillPath, "---\nname: genui\n---\n\n[paseo-plugin-genui]\n\n[paseo-plugin-genui]\n\n# Inline UI reference\n");
  const withGenui = new CoordinatorLifecycle(f.prefs, f.directory, skillPath);
  await withGenui.ensure(f.sdk, start);
  const prompt: string = f.creations[0].config.systemPrompt;
  expect(prompt).toContain("read_board_conversation");
  expect(prompt).toContain("genui(메인 세션 전용)");
  expect(prompt).toContain("# Inline UI reference");
  expect(prompt.split("[paseo-plugin-genui]").length - 1).toBe(1);
  expect(prompt).not.toContain("name: genui");
});
