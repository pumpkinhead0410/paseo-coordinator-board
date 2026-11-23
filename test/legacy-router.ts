import { effectiveWorkerMode, includedCatalog, resolveRoute, sameRoute, type Grade } from "../shared/dispatch";
import type { RouteDecision } from "../shared/route-decision";
import type { RouteContext, Router } from "../server/routes";

// 기존 시험의 가짜 Router: 호스트 Selector 없이 업스트림 추천표로 판정해, 보드의 요청 키·영수증·권한 모드 시험을 그대로 유지한다.
function decide(grade: Grade, ctx: RouteContext): RouteDecision {
  const route = resolveRoute(grade, ctx.scope.routing, includedCatalog(ctx.catalog, ctx.scope.excludedProviders), !!ctx.needsHooks);
  if (!route) return { kind: "held", source: "selector", hold: { code: "no-match" } };
  const modeId = grade === "M" ? ctx.catalog.find(m => m.provider === route.provider)?.coordinatorMode?.id : effectiveWorkerMode(route.provider, ctx.scope.workerModeOverrides);
  return { kind: "ready", source: ctx.scope.routing[grade] ? "saved" : "selector", route, ...(modeId && { modeId }) };
}

export function legacyRouter(): Router {
  return {
    async plan(grades, ctx) {
      return { decisions: Object.fromEntries(grades.map(g => [g, decide(g, ctx)])) as never, refreshing: false };
    },
    async confirm(grade, expected, ctx) {
      const decision = decide(grade, ctx);
      return decision.kind === "ready" && sameRoute(decision.route, expected) ? decision : { kind: "held", source: decision.source, hold: { code: "plan-changed" } };
    },
  };
}
