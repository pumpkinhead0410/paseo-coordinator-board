import { z } from "zod";
import { gradeSchema, routeChoiceSchema, type Grade, type RouteChoice } from "./dispatch";

export type Translate = (korean: string, english: string) => string;
export const koreanOnly: Translate = korean => korean;

// 등급을 로컬 프로필 Selector의 (역할, 강도)로 바꾸는 유일한 표입니다.
export const GRADE_SPEC = {
  A: { role: "deep", effort: "xhigh" },
  B: { role: "deep", effort: "high" },
  C: { role: "work", effort: "high" },
  D: { role: "work", effort: "medium" },
  M: { role: "deep", effort: "high" },
} as const satisfies Record<Grade, { role: "deep" | "work"; effort: "medium" | "high" | "xhigh" }>;
export type SelectorRole = (typeof GRADE_SPEC)[Grade]["role"];
export type SelectorEffort = (typeof GRADE_SPEC)[Grade]["effort"];

export const holdCodeSchema = z.enum([
  "selector-unavailable", "selector-defer", "no-match", "all-exhausted", "board-filtered", "plan-changed", "saved-unavailable",
]);
export type HoldCode = z.infer<typeof holdCodeSchema>;

export const holdSchema = z.object({
  code: holdCodeSchema,
  detail: z.string().max(400).optional(),
  earliestResetAt: z.string().max(64).optional(),
});
export type Hold = z.infer<typeof holdSchema>;

const source = z.enum(["saved", "selector"]);
export const routeDecisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ready"), source, route: routeChoiceSchema,
    modeId: z.string().min(1).max(256).optional(), profileId: z.string().min(1).max(256).optional(), why: z.string().max(400).optional(),
  }),
  z.object({ kind: z.literal("held"), source, hold: holdSchema }),
]);
export type RouteDecision = z.infer<typeof routeDecisionSchema>;

export const routePreviewSchema = z.object({
  decisions: z.partialRecord(gradeSchema, routeDecisionSchema),
  refreshing: z.boolean(),
});
export type RoutePreview = z.infer<typeof routePreviewSchema>;

export function readyRoute(decision: RouteDecision | undefined): RouteChoice | null {
  return decision?.kind === "ready" ? decision.route : null;
}

function stamp(iso: string | undefined, t: Translate) {
  if (!iso || Number.isNaN(Date.parse(iso))) return "";
  const at = new Date(iso);
  const format = (locale: string) => at.toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return t(format("ko-KR"), format("en-US"));
}

// 보류 문구를 만드는 유일한 곳입니다. 코디네이터 도구 오류와 화면이 같은 문장을 씁니다.
export function holdText(hold: Hold, t: Translate): string {
  const detail = hold.detail ? " (" + hold.detail + ")" : "";
  switch (hold.code) {
    case "selector-unavailable":
      return t("이 호스트의 로컬 프로필 Selector를 실행하지 못해 배정을 보류했습니다.", "Assignment is on hold because the local profile selector could not run on this host.") + detail;
    case "selector-defer":
      return t("로컬 프로필 Selector가 판단을 보류해 배정을 보류했습니다. 잠시 뒤 다시 시도하세요.", "Assignment is on hold because the local profile selector deferred. Try again shortly.") + detail;
    case "no-match":
      return t("조건에 맞는 프로필이 없어 배정을 보류했습니다.", "Assignment is on hold because no profile matches.") + detail;
    case "all-exhausted": {
      const reset = stamp(hold.earliestResetAt, t);
      return t("모든 후보의 한도가 소진되어 보류했습니다." + (reset ? ` ${reset} 이후 다시 시도하세요.` : ""),
        "Every candidate is out of quota, so assignment is on hold." + (reset ? ` Try again after ${reset}.` : "")) + detail;
    }
    case "board-filtered":
      return t("Selector 후보가 있지만 이 보드의 조건(제외한 실행기·모델 목록·훅·코디네이터 권한 모드)을 통과한 후보가 없어 보류했습니다.",
        "The selector has candidates, but none pass this board's conditions (excluded providers, model catalog, hooks, coordinator mode), so assignment is on hold.") + detail;
    case "plan-changed":
      return t("계획한 모델을 더는 배정할 수 없습니다. plan_board_assignment를 다시 실행하세요.", "The planned model can no longer be assigned. Run plan_board_assignment again.") + detail;
    case "saved-unavailable":
      return t("저장한 배정 순서의 후보를 이 호스트에서 사용할 수 없어 보류했습니다.", "None of the saved route candidates is usable on this host, so assignment is on hold.") + detail;
  }
}
