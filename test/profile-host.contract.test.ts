import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CatalogModel } from "../shared/dispatch";
import { createProfileHost } from "../server/profile-host";
import { createRouter } from "../server/routes";

// 실제 profile_selector.py·quota_state.py를 호출해 JSON 계약을 확인한다.
// --profiles·--state는 임시 폴더만 쓰며 실제 상태 파일(~/.local/state/...)은 읽지도 쓰지도 않는다.
function hostRoot() {
  try {
    const root = dirname(dirname(realpathSync(join(homedir(), ".agents", "guides", "paseo.md"))));
    return ["profile_selector.py", "quota_state.py", "agent-profiles.json"].every(name => existsSync(join(root, "paseo", name))) ? root : null;
  } catch { return null; }
}
const root = hostRoot();
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function sandbox(usage: unknown[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "profile-contract-"));
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "state"));
  const profilesPath = join(dir, "agent-profiles.json");
  copyFileSync(join(root!, "paseo", "agent-profiles.json"), profilesPath);
  const statePath = join(dir, "state", "quota-state.json");
  writeFileSync(join(dir, "usage.json"), JSON.stringify(usage));
  writeFileSync(join(dir, "bin", "paseo"), `#!/bin/sh\necho "$@" >> "${dir}/paseo.log"\ncat "${dir}/usage.json"\n`);
  chmodSync(join(dir, "bin", "paseo"), 0o755);
  const host = createProfileHost({
    profilesPath, statePath, scriptTimeoutMs: 10_000,
    env: { ...process.env, PATH: join(dir, "bin") + ":" + process.env.PATH, XDG_STATE_HOME: join(dir, "state") },
  });
  const paseoCalls = () => existsSync(join(dir, "paseo.log")) ? readFileSync(join(dir, "paseo.log"), "utf8").trim().split("\n") : [];
  return { dir, host, statePath, paseoCalls };
}

const realState = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "agent-config/paseo/quota-state.json");
const mtime = () => existsSync(realState) ? statSync(realState).mtimeMs : null;

test.skipIf(!root)("등급 4종이 실제 Selector에서 역할·강도에 맞는 순위 목록을 돌려주고 전문화 프로필은 자유 순위에서 빠진다", async () => {
  const before = mtime();
  const { host } = sandbox();
  for (const [role, effort] of [["deep", "xhigh"], ["deep", "high"], ["work", "high"], ["work", "medium"]] as const) {
    const ranking = await host.rank(role, effort);
    if (ranking.status !== "ranked") throw new Error(`${role}.${effort}: ${ranking.status} ${ranking.why}`);
    expect(ranking.profiles.length).toBeGreaterThan(1);
    expect(ranking.covered).toBe(true);
    expect(ranking.profiles[0].modeId).toBeTruthy();
    for (const p of ranking.profiles) {
      expect(p.id.startsWith(role + ".") && p.id.endsWith("." + effort)).toBe(true);
      expect(p.route.effort).toBe(effort);
    }
    // 빈 상태에서는 모든 후보의 조회 기한이 도래해 갱신 후보가 나온다.
    expect(ranking.refreshDue.length).toBeGreaterThan(0);
  }
  const medium = await host.rank("work", "medium");
  if (medium.status !== "ranked") throw new Error("ranked expected");
  expect(medium.profiles.map(p => p.id)).not.toContain("work.codex.terra.medium");
  expect(mtime()).toBe(before);
});

test.skipIf(!root)("AGY 프로필은 모델 ID와 강도를 분리하고 권한 모드 auto를 돌려준다", async () => {
  const { host } = sandbox();
  const described = await host.describe("work.agy.hydrogen.high");
  expect(described).toMatchObject({
    status: "described",
    profile: { id: "work.agy.hydrogen.high", quotaPool: "agy-gemini", modeId: "auto", route: { provider: "antigravity", model: "gemini-4-hydrogen", effort: "high" } },
  });
  expect(await host.describe("no.such.profile.high")).toMatchObject({ status: "no-match" });
});

test.skipIf(!root)("claim-query → 가짜 paseo usage → finish-query가 임시 상태 파일만 갱신하고, 조회권은 한 번만 쓴다", async () => {
  const before = mtime();
  const now = new Date().toISOString();
  const usage = [{ sourceId: "claude", id: "claude-report", fetchedAt: now, successfulAt: now,
    report: { status: "available", windows: [{ id: "weekly", remainingPct: 0 }, { id: "five_hour", remainingPct: 60 }] } }];
  const { host, statePath, paseoCalls } = sandbox(usage);
  const first = await host.rank("deep", "high");
  if (first.status !== "ranked") throw new Error("ranked expected");
  expect(first.profiles.map(p => p.id)).toContain("deep.claude.opus.high");

  expect(await host.refresh(first.refreshDue)).toEqual({ kind: "refreshed" });
  expect(paseoCalls()).toEqual(["usage --json"]);
  expect(existsSync(statePath)).toBe(true);

  // claude 풀이 소진으로 기록되어 자유 순위에서 빠진다.
  const second = await host.rank("deep", "high");
  if (second.status !== "ranked") throw new Error(`ranked expected: ${second.status}`);
  expect(second.profiles.map(p => p.id)).not.toContain("deep.claude.opus.high");

  // 곧바로 다시 갱신하면 조회권을 얻지 못하고 명령도 실행하지 않는다.
  const again = await host.refresh(first.refreshDue);
  expect(again.kind).toBe("skipped");
  expect(paseoCalls()).toEqual(["usage --json"]);
  expect(mtime()).toBe(before);
});

test.skipIf(!root)("손상된 상태 파일이면 Selector가 defer로 보류하고 파일을 건드리지 않는다", async () => {
  const { host, statePath } = sandbox();
  writeFileSync(statePath, "{not json");
  writeFileSync(statePath + ".lock", "");
  expect(await host.rank("deep", "high")).toMatchObject({ status: "defer", why: expect.stringContaining("damaged") });
  expect(readFileSync(statePath, "utf8")).toBe("{not json");
});

test.skipIf(!root)("실제 Selector와 Router를 이으면 모든 등급이 배정되고, 미리보기한 경로는 그대로 확정되며, AGY만 남아도 권한 모드 auto로 배정된다", async () => {
  const { host, dir } = sandbox();
  const profiles = (JSON.parse(readFileSync(join(dir, "agent-profiles.json"), "utf8")) as { agentProfiles: { provider: string; model: string; thinkingOptionId: string }[] }).agentProfiles;
  const modes: Record<string, { id: string; label: string }> = { claude: { id: "auto", label: "Auto" }, codex: { id: "auto-review", label: "Auto-review" }, antigravity: { id: "auto", label: "Auto" } };
  const catalog: CatalogModel[] = [];
  for (const p of profiles) {
    const entry = catalog.find(m => m.provider === p.provider && m.model === p.model)
      ?? (catalog.push({ provider: p.provider, model: p.model, label: p.model, efforts: [], isDefault: false, coordinatorMode: modes[p.provider] ?? null }), catalog.at(-1)!);
    if (!entry.efforts.includes(p.thinkingOptionId)) entry.efforts.push(p.thinkingOptionId);
  }
  const router = createRouter(host);
  const grades = ["A", "B", "C", "D", "M"] as const;
  const scope = { routing: {}, excludedProviders: [] as string[], workerModeOverrides: {} };
  const { decisions } = await router.plan(grades, { scope, catalog }, "none");
  for (const grade of grades) {
    const decision = decisions[grade];
    if (decision.kind !== "ready") throw new Error(`${grade}: ${JSON.stringify(decision)}`);
    expect(decision.source).toBe("selector");
    expect(decision.modeId).toBeTruthy();
    expect(await router.confirm(grade, decision.route, { scope, catalog })).toMatchObject({ kind: "ready", route: decision.route });
  }
  const agy = { ...scope, excludedProviders: ["claude", "codex"] };
  const only = await router.plan(grades, { scope: agy, catalog }, "none");
  for (const grade of grades) {
    const decision = only.decisions[grade];
    if (decision.kind !== "ready") throw new Error(`${grade}: ${JSON.stringify(decision)}`);
    expect(decision.route.provider).toBe("antigravity");
    expect(decision.modeId).toBe("auto");
  }
  // AGY 3P(claude-*)는 xhigh를 노출하지 않으므로 A는 Gemini 후보만 남는다.
  const a = only.decisions.A;
  expect(a.kind === "ready" && a.route.model).toBe("gemini-4-neon");
});
