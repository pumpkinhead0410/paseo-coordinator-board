import {
  eligibleProvider, effectiveWorkerMode, includedCatalog, resolveRoute, sameRoute,
  type CatalogModel, type Grade, type RouteChoice, type RoutePolicy,
} from "../shared/dispatch";
import { GRADE_SPEC, type Hold, type RouteDecision } from "../shared/route-decision";
import { createProfileHost, type Failure, type ProfileHost, type RankedProfile, type Ranking, type RefreshCandidate } from "./profile-host";

// 이 모듈이 배정 정책의 유일한 입구입니다. 저장 순서가 있으면 그것을, 없으면 로컬 Selector를 씁니다.
// 내장 추천표로 되돌아가지 않습니다. resolveRoute는 저장 순서를 읽는 데만 쓰입니다.

export type RoutingScope = {
  routing: RoutePolicy;
  excludedProviders: readonly string[];
  workerModeOverrides?: Readonly<Record<string, string | undefined>>;
};
export type RouteContext = { scope: RoutingScope; catalog: CatalogModel[]; needsHooks?: boolean };
export type RefreshMode = "await" | "background" | "none";

export interface Router {
  plan<G extends Grade>(grades: readonly G[], ctx: RouteContext, refresh: RefreshMode): Promise<{ decisions: Record<G, RouteDecision>; refreshing: boolean }>;
  confirm(grade: Grade, expected: RouteChoice, ctx: RouteContext): Promise<RouteDecision>;
}

// 비동기 판정이 끝난 뒤 설정이 바뀌었는지 비교하는 값입니다. 판정에 쓰인 설정만 담습니다.
export function routingFingerprint(scope: RoutingScope, grade: Grade, provider?: string) {
  const overrides = scope.workerModeOverrides ?? {};
  return JSON.stringify([
    scope.routing[grade] ?? null, [...scope.excludedProviders].sort(),
    provider && Object.hasOwn(overrides, provider) ? overrides[provider] : null,
  ]);
}

const held = (source: "saved" | "selector", code: Hold["code"], detail?: string, earliestResetAt?: string | null): RouteDecision => ({
  kind: "held", source,
  hold: { code, ...(detail && { detail: detail.slice(0, 400) }), ...(earliestResetAt && { earliestResetAt }) },
});

function savedDecision(grade: Grade, ctx: RouteContext): RouteDecision {
  const saved = ctx.scope.routing[grade]!;
  const route = resolveRoute(grade, { [grade]: saved }, includedCatalog(ctx.catalog, ctx.scope.excludedProviders), !!ctx.needsHooks);
  if (!route) return held("saved", "saved-unavailable");
  const mode = grade === "M"
    ? ctx.catalog.find(m => m.provider === route.provider)?.coordinatorMode?.id
    : effectiveWorkerMode(route.provider, ctx.scope.workerModeOverrides);
  return { kind: "ready", source: "saved", route, ...(mode && { modeId: mode }) };
}

// 보드 조건. Selector가 모르는 사용자 설정과 이 호스트의 카탈로그만 여기서 거릅니다.
function boardReason(profile: RankedProfile, grade: Grade, ctx: RouteContext, included: CatalogModel[]): string | null {
  const { provider, model, effort } = profile.route;
  if (ctx.scope.excludedProviders.includes(provider)) return "excluded-provider";
  const entry = ctx.catalog.find(m => m.provider === provider && m.model === model);
  if (!entry) return "not-in-catalog";
  if (effort !== null && !entry.efforts.includes(effort)) return "no-effort";
  if (grade === "M" && !entry.coordinatorMode) return "no-coordinator-mode";
  if (!eligibleProvider(grade, provider, !!ctx.needsHooks, included))
    return ctx.needsHooks && eligibleProvider(grade, provider, false, included) ? "no-hooks" : "ineligible";
  return null;
}

function mapFailure(failure: Failure): RouteDecision {
  switch (failure.status) {
    case "unavailable": return held("selector", "selector-unavailable", failure.why);
    case "defer": return held("selector", "selector-defer", failure.why);
    case "no-match": return held("selector", "no-match", failure.why);
    case "all-exhausted": return held("selector", "all-exhausted", undefined, failure.earliestResetAt);
  }
}

export function createRouter(host: ProfileHost = createProfileHost()): Router {
  const specKey = (grade: Grade) => GRADE_SPEC[grade].role + ":" + GRADE_SPEC[grade].effort;
  const rankFor = (grade: Grade) => host.rank(GRADE_SPEC[grade].role, GRADE_SPEC[grade].effort);

  // 미리보기(plan)와 실제 배정(confirm)이 함께 쓰는 하나의 판정입니다.
  async function decide(grade: Grade, ranking: Ranking, ctx: RouteContext, expected?: RouteChoice): Promise<RouteDecision> {
    if (ranking.status !== "ranked") return mapFailure(ranking);
    const included = includedCatalog(ctx.catalog, ctx.scope.excludedProviders);
    const counts = new Map<string, number>();
    const allowed = ranking.profiles.filter(p => {
      const reason = boardReason(p, grade, ctx, included);
      if (reason) counts.set(reason, (counts.get(reason) ?? 0) + 1);
      return !reason;
    });
    const detail = [...counts].map(([reason, n]) => `${reason}×${n}`).join(", ");
    const pick = expected ? allowed.find(p => sameRoute(p.route, expected)) : allowed[0];
    if (!pick) {
      // 순위 목록이 잘렸으면 목록에 없다는 사실로 결론 내리지 않습니다.
      if (!ranking.covered) return held("selector", "selector-defer", "ranking list was truncated");
      if (!expected) return held("selector", "board-filtered", detail || undefined);
      // 기대 경로 자신이 보드 조건에 걸린 경우에만 그 사유를 붙입니다.
      const own = ranking.profiles.find(p => sameRoute(p.route, expected));
      const ownReason = own ? boardReason(own, grade, ctx, included) : null;
      return held("selector", "plan-changed", ownReason ?? undefined);
    }
    let profile = pick;
    if (!profile.modeId) {
      const described = await host.describe(pick.id);
      if (described.status !== "described") return mapFailure(described);
      if (!sameRoute(described.profile.route, pick.route)) return held("selector", "selector-defer", "profile route changed");
      profile = described.profile;
    }
    const overrides = ctx.scope.workerModeOverrides;
    const modeId = grade === "M"
      ? ctx.catalog.find(m => m.provider === profile.route.provider)?.coordinatorMode?.id
      : overrides && Object.hasOwn(overrides, profile.route.provider) ? overrides[profile.route.provider] : profile.modeId;
    const why = pick === ranking.profiles[0] ? ranking.why : `${ranking.why} → ${pick.id}`;
    return { kind: "ready", source: "selector", route: profile.route, profileId: profile.id, why: why.slice(0, 400), ...(modeId && { modeId }) };
  }

  return {
    async plan(grades, ctx, refresh) {
      const decisions: Partial<Record<Grade, RouteDecision>> = {};
      const pending: Grade[] = [];
      for (const grade of grades) {
        if (ctx.scope.routing[grade]?.length) decisions[grade] = savedDecision(grade, ctx);
        else pending.push(grade);
      }
      let refreshing = false;
      if (pending.length) {
        const keys = [...new Set(pending.map(specKey))];
        const rankAll = async () => new Map(await Promise.all(keys.map(async key => [key, await rankFor(pending.find(g => specKey(g) === key)!)] as const)));
        let rankings = await rankAll();
        const due = new Map<string, RefreshCandidate>();
        for (const ranking of rankings.values()) for (const c of ranking.refreshDue) due.set(JSON.stringify(c), c);
        if (due.size && refresh === "await") {
          // 여러 등급의 갱신을 한 번으로 모읍니다. 갱신하지 못했으면 다시 고르지 않습니다.
          if ((await host.refresh([...due.values()])).kind === "refreshed") rankings = await rankAll();
        } else if (due.size && refresh === "background") {
          void host.refresh([...due.values()]);
          refreshing = true;
        }
        for (const grade of pending) decisions[grade] = await decide(grade, rankings.get(specKey(grade))!, ctx);
      }
      return { decisions: decisions as Record<(typeof grades)[number], RouteDecision>, refreshing };
    },

    async confirm(grade, expected, ctx) {
      if (ctx.scope.routing[grade]?.length) {
        const saved = savedDecision(grade, ctx);
        return saved.kind === "held" || sameRoute(saved.route, expected) ? saved : held("saved", "plan-changed");
      }
      return decide(grade, await rankFor(grade), ctx, expected);
    },
  };
}
