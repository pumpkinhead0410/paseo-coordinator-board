import { describe, expect, test } from "bun:test";
import type { CatalogModel, Grade, RouteChoice } from "../shared/dispatch";
import { GRADE_SPEC, holdText } from "../shared/route-decision";
import type { Described, Failure, ProfileHost, RankedProfile, Ranking, RefreshCandidate, RefreshOutcome } from "../server/profile-host";
import { createRouter, type RouteContext } from "../server/routes";

const model = (provider: string, id: string, efforts: string[], extra: Partial<CatalogModel> = {}): CatalogModel =>
  ({ provider, model: id, label: id, efforts, isDefault: false, ...extra });
const catalog: CatalogModel[] = [
  model("claude", "claude-opus-5-5", ["high", "xhigh"], { coordinatorMode: { id: "auto", label: "Auto" } }),
  model("codex", "gpt-6.2-astra", ["high", "xhigh"], { coordinatorMode: { id: "auto-review", label: "Auto-review" } }),
  model("codex", "gpt-6.2-sol", ["medium", "high"], { coordinatorMode: { id: "auto-review", label: "Auto-review" } }),
  model("antigravity", "gemini-4-neon", ["high", "xhigh"], { coordinatorMode: { id: "auto", label: "Auto" } }),
  model("antigravity", "gemini-4-hydrogen", ["medium", "high"], { coordinatorMode: { id: "auto", label: "Auto" } }),
];
const ranked = (id: string, provider: string, m: string, effort: string, modeId?: string): RankedProfile =>
  ({ id, quotaPool: provider, route: { provider, model: m, effort }, ...(modeId && { modeId }) });
const opus = ranked("deep.claude.opus.high", "claude", "claude-opus-5-5", "high", "auto");
const astra = ranked("deep.codex.astra.high", "codex", "gpt-6.2-astra", "high", "auto-review");
const neon = ranked("deep.agy.neon.high", "antigravity", "gemini-4-neon", "high", "auto");
const hydrogen = ranked("work.agy.hydrogen.high", "antigravity", "gemini-4-hydrogen", "high", "auto");
const sol = ranked("work.codex.sol.high", "codex", "gpt-6.2-sol", "high", "auto-review");
const ok = (...profiles: RankedProfile[]): Ranking => ({ status: "ranked", profiles, why: profiles[0].id + " via tier", covered: true, refreshDue: [] });

type Script = { rank?: (role: string, effort: string) => Ranking; describe?: (id: string) => Described; refresh?: () => Promise<RefreshOutcome> };
function fakeHost(script: Script) {
  const calls = { rank: [] as string[], describe: [] as string[], refresh: [] as RefreshCandidate[][] };
  const host: ProfileHost = {
    async rank(role, effort) { calls.rank.push(role + ":" + effort); return script.rank!(role, effort); },
    async describe(id) { calls.describe.push(id); return script.describe!(id); },
    async refresh(due) { calls.refresh.push([...due]); return script.refresh ? script.refresh() : { kind: "refreshed" }; },
  };
  return { host, calls };
}
const scope = (extra: Partial<RouteContext["scope"]> = {}): RouteContext["scope"] => ({ routing: {}, excludedProviders: [], workerModeOverrides: {}, ...extra });
const ctx = (extra: Partial<RouteContext> = {}): RouteContext => ({ scope: scope(), catalog, ...extra });
const failure = (status: Failure["status"], why = "reason"): Failure => status === "no-match" || status === "all-exhausted"
  ? { status, why, earliestResetAt: status === "all-exhausted" ? "2026-11-25T02:33:00Z" : null, refreshDue: [] } : { status, why, refreshDue: [] };

describe("불일치 회귀: 미리보기와 실제 배정", () => {
  test("순위 1위가 바뀌어도 미리보기한 후보가 목록에 있으면 confirm이 통과한다", async () => {
    let order = [opus, astra, neon];
    const { host } = fakeHost({ rank: () => ok(...order), describe: id => ({ status: "described", profile: { ...order.find(p => p.id === id)!, modeId: "auto-review" } }) });
    const router = createRouter(host);
    const planned = (await router.plan(["B"], ctx(), "none")).decisions.B;
    expect(planned).toMatchObject({ kind: "ready", route: opus.route });
    // 5분 구간이 바뀌어 동률 정렬이 뒤집힌 상황
    order = [astra, neon, opus];
    expect(await router.confirm("B", opus.route, ctx())).toMatchObject({ kind: "ready", source: "selector", route: opus.route, profileId: opus.id });
    expect(await router.confirm("B", astra.route, ctx())).toMatchObject({ kind: "ready", route: astra.route });
  });

  test("미리보기한 후보가 순위에서 사라졌으면 plan-changed로 보류한다", async () => {
    let order = [opus, astra];
    const { host } = fakeHost({ rank: () => ok(...order) });
    const router = createRouter(host);
    expect((await router.plan(["B"], ctx(), "none")).decisions.B).toMatchObject({ kind: "ready", route: opus.route });
    order = [astra];
    expect(await router.confirm("B", opus.route, ctx())).toEqual({ kind: "held", source: "selector", hold: { code: "plan-changed" } });
  });

  test("전문화 프로필은 자유 순위에 없으므로 기대 경로로 들어와도 거부한다", async () => {
    const terra = ranked("work.codex.terra.medium", "codex", "gpt-6.1-terra", "medium", "auto-review");
    const solMedium = ranked("work.codex.sol.medium", "codex", "gpt-6.2-sol", "medium", "auto-review");
    const { host, calls } = fakeHost({ rank: () => ok(solMedium) });
    const decision = await createRouter(host).confirm("D", terra.route, ctx({ catalog: [...catalog, model("codex", "gpt-6.1-terra", ["medium"])] }));
    expect(decision).toMatchObject({ kind: "held", hold: { code: "plan-changed" } });
    expect(calls.describe).toEqual([]);
  });

  test("순위 목록이 잘렸으면 없다고 결론 내리지 않고 selector-defer로 보류한다", async () => {
    const { host } = fakeHost({ rank: () => ({ ...ok(opus), covered: false }) });
    expect(await createRouter(host).confirm("B", astra.route, ctx())).toMatchObject({ kind: "held", hold: { code: "selector-defer" } });
  });
});

describe("등급 표와 Selector 입력", () => {
  test("등급을 확정한 (역할, 강도)로 넘기고 같은 값은 한 번만 묻는다", async () => {
    const { host, calls } = fakeHost({ rank: () => ok(opus) });
    await createRouter(host).plan(["A", "B", "C", "D", "M"], ctx(), "none");
    expect(GRADE_SPEC).toEqual({
      A: { role: "deep", effort: "xhigh" }, B: { role: "deep", effort: "high" }, C: { role: "work", effort: "high" },
      D: { role: "work", effort: "medium" }, M: { role: "deep", effort: "high" },
    });
    expect([...calls.rank].sort()).toEqual(["deep:high", "deep:xhigh", "work:high", "work:medium"]);
  });
});

describe("저장 순서가 Selector보다 우선한다", () => {
  test("저장한 순서의 첫 가용 후보를 쓰고 Selector를 묻지 않는다", async () => {
    const { host, calls } = fakeHost({ rank: () => ok(opus) });
    const saved: RouteChoice[] = [{ provider: "nowhere", model: "x", effort: null }, sol.route];
    const router = createRouter(host);
    const { decisions } = await router.plan(["C"], ctx({ scope: scope({ routing: { C: saved } }) }), "await");
    expect(decisions.C).toEqual({ kind: "ready", source: "saved", route: sol.route, modeId: "auto-review" });
    expect(calls.rank).toEqual([]);
    expect(await router.confirm("C", sol.route, ctx({ scope: scope({ routing: { C: saved } }) }))).toMatchObject({ kind: "ready", source: "saved" });
    expect(await router.confirm("C", hydrogen.route, ctx({ scope: scope({ routing: { C: saved } }) }))).toMatchObject({ kind: "held", hold: { code: "plan-changed" } });
  });

  test("저장한 후보가 모두 사용 불가이면 내장 추천표나 Selector로 대체하지 않고 보류한다", async () => {
    const { host, calls } = fakeHost({ rank: () => ok(opus) });
    const bad = { C: [{ provider: "nowhere", model: "x", effort: null }] };
    const { decisions } = await createRouter(host).plan(["C"], ctx({ scope: scope({ routing: bad }) }), "none");
    expect(decisions.C).toEqual({ kind: "held", source: "saved", hold: { code: "saved-unavailable" } });
    expect(calls.rank).toEqual([]);
  });

  test("저장한 AGY 후보도 A 등급에서 쓸 수 있고 기본 권한은 auto이다", async () => {
    const { host } = fakeHost({ rank: () => ok(opus) });
    const saved = { A: [{ provider: "antigravity", model: "gemini-4-neon", effort: "xhigh" }] };
    const { decisions } = await createRouter(host).plan(["A"], ctx({ scope: scope({ routing: saved }) }), "none");
    expect(decisions.A).toMatchObject({ kind: "ready", source: "saved", modeId: "auto" });
  });
});

describe("Selector 실패는 내장 추천표 없이 보류로 바뀐다", () => {
  const cases: [Failure["status"], string][] = [
    ["unavailable", "selector-unavailable"], ["defer", "selector-defer"], ["no-match", "no-match"], ["all-exhausted", "all-exhausted"],
  ];
  for (const [status, code] of cases) {
    test(status, async () => {
      const { host } = fakeHost({ rank: () => failure(status) });
      const router = createRouter(host);
      const { decisions } = await router.plan(["A", "C"], ctx(), "none");
      for (const grade of ["A", "C"] as const) expect(decisions[grade]).toMatchObject({ kind: "held", source: "selector", hold: { code } });
      expect(await router.confirm("C", sol.route, ctx())).toMatchObject({ kind: "held", hold: { code } });
    });
  }
  test("전체 소진은 가장 이른 초기화 시각과 안내 문구를 함께 낸다", async () => {
    const { host } = fakeHost({ rank: () => failure("all-exhausted") });
    const decision = (await createRouter(host).plan(["A"], ctx(), "none")).decisions.A;
    if (decision.kind !== "held") throw new Error("held expected");
    expect(decision.hold.earliestResetAt).toBe("2026-11-25T02:33:00Z");
    expect(holdText(decision.hold, k => k)).toMatch(/소진.*다시 시도/);
    expect(holdText(decision.hold, (_, e) => e)).toMatch(/out of quota.*Try again after/);
  });
});

describe("보드 조건", () => {
  const plan = async (grade: Grade, c: RouteContext, profiles: RankedProfile[] = [opus, astra, neon, hydrogen, sol]) => {
    const { host } = fakeHost({ rank: () => ok(...profiles), describe: id => ({ status: "described", profile: { ...profiles.find(p => p.id === id)!, modeId: "auto" } }) });
    return (await createRouter(host).plan([grade], c, "none")).decisions[grade];
  };
  test("제외한 실행기는 건너뛴다", async () => {
    expect(await plan("B", ctx({ scope: scope({ excludedProviders: ["claude"] }) }))).toMatchObject({ kind: "ready", route: astra.route });
  });
  test("카탈로그에 없는 모델이나 강도가 없는 후보는 건너뛴다", async () => {
    expect(await plan("B", ctx({ catalog: catalog.filter(m => m.provider !== "claude") }))).toMatchObject({ route: astra.route });
    const noHigh = catalog.map(m => m.model === "claude-opus-5-5" ? { ...m, efforts: ["xhigh"] } : m);
    expect(await plan("B", ctx({ catalog: noHigh }))).toMatchObject({ route: astra.route });
  });
  test("훅이 필요하면 AGY를 제외한다", async () => {
    expect(await plan("B", ctx({ needsHooks: true }), [neon, opus])).toMatchObject({ route: opus.route });
    expect(await plan("B", ctx({ needsHooks: true }), [neon])).toMatchObject({ kind: "held", hold: { code: "board-filtered", detail: "no-hooks×1" } });
  });
  test("M은 코디네이터 권한 모드가 있는 후보만 쓰고 그 모드를 돌려준다", async () => {
    const noMode = catalog.map(m => m.provider === "claude" ? { ...m, coordinatorMode: null } : m);
    expect(await plan("M", ctx({ catalog: noMode }))).toMatchObject({ route: astra.route, modeId: "auto-review" });
    expect(await plan("M", ctx({ catalog: noMode.filter(m => m.provider === "claude") }), [opus])).toMatchObject({ hold: { code: "board-filtered" } });
    expect(await plan("M", ctx(), [neon])).toMatchObject({ route: neon.route, modeId: "auto" });
  });
  test("권한 모드 재정의가 프로필 기본값보다 우선한다", async () => {
    expect(await plan("B", ctx({ scope: scope({ workerModeOverrides: { claude: "default" } }) }))).toMatchObject({ route: opus.route, modeId: "default" });
    expect(await plan("B", ctx({ scope: scope({ workerModeOverrides: { codex: "x" } }) }))).toMatchObject({ route: opus.route, modeId: "auto" });
  });
  test("1위가 아닌 후보는 describe로 권한 모드를 받아 온다", async () => {
    const alternative = { ...neon, modeId: undefined };
    const { host, calls } = fakeHost({
      rank: () => ok(opus, alternative), describe: id => ({ status: "described", profile: { ...neon, id, modeId: "auto" } }),
    });
    const decision = (await createRouter(host).plan(["B"], ctx({ scope: scope({ excludedProviders: ["claude"] }) }), "none")).decisions.B;
    expect(decision).toMatchObject({ kind: "ready", route: neon.route, profileId: neon.id, modeId: "auto" });
    expect(calls.describe).toEqual([neon.id]);
  });
});

describe("사용량 갱신", () => {
  const due: RefreshCandidate[] = [{ provider: "claude", model: "claude-opus-5-5" }];
  test("여러 등급의 갱신은 한 번만 일어나고 성공하면 다시 선택한다", async () => {
    let refreshed = false;
    const { host, calls } = fakeHost({
      rank: () => ({ ...ok(refreshed ? astra : opus), refreshDue: refreshed ? [] : due }),
      refresh: async () => { refreshed = true; return { kind: "refreshed" }; },
    });
    const { decisions, refreshing } = await createRouter(host).plan(["A", "B", "C", "D"], ctx(), "await");
    expect(calls.refresh).toEqual([due]);
    expect(refreshing).toBe(false);
    expect(decisions.B).toMatchObject({ route: astra.route });
  });
  test("갱신을 건너뛰거나 실패하면 다시 선택하지 않는다", async () => {
    for (const outcome of [{ kind: "skipped", reason: "query-in-progress" }, { kind: "failed", reason: "timeout" }] as RefreshOutcome[]) {
      const { host, calls } = fakeHost({ rank: () => ({ ...ok(opus), refreshDue: due }), refresh: async () => outcome });
      await createRouter(host).plan(["B"], ctx(), "await");
      expect(calls.rank).toHaveLength(1);
    }
  });
  test("background 모드는 갱신을 기다리지 않고 refreshing을 표시한다", async () => {
    const { host, calls } = fakeHost({ rank: () => ({ ...ok(opus), refreshDue: due }), refresh: () => new Promise<RefreshOutcome>(() => {}) });
    const { decisions, refreshing } = await createRouter(host).plan(["B"], ctx(), "background");
    expect(refreshing).toBe(true);
    expect(calls.refresh).toHaveLength(1);
    expect(decisions.B).toMatchObject({ kind: "ready" });
  });
  test("none 모드와 confirm은 갱신하지 않는다", async () => {
    const { host, calls } = fakeHost({ rank: () => ({ ...ok(opus), refreshDue: due }) });
    const router = createRouter(host);
    await router.plan(["B"], ctx(), "none");
    await router.confirm("B", opus.route, ctx());
    expect(calls.refresh).toEqual([]);
  });
});
