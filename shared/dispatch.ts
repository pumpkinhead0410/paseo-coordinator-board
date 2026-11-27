import { z } from "zod";
import { preferCapacity, type AccountUsage } from "./usage-routing";

const identifier = z.string().min(1).max(256);
const projectId = z.string().min(1).max(4096);
export const gradeSchema = z.enum(["A", "B", "C", "D", "M"]);
export const workerGradeSchema = z.enum(["A", "B", "C", "D"]);
export const routeChoiceSchema = z.object({
  provider: identifier,
  model: identifier,
  effort: identifier.nullable(),
});
export const workerModeProvider = identifier.refine(id => !["__proto__", "constructor", "prototype"].includes(id));
export function recommendedWorkerMode(provider: string): string | undefined {
  if (provider === "claude") return "auto";
  if (provider === "codex") return "auto-review";
  if (provider === "antigravity") return "auto";
}
export function effectiveWorkerMode(provider: string, overrides?: Record<string, string | undefined>): string | undefined {
  return overrides && Object.hasOwn(overrides, provider) ? overrides[provider] : recommendedWorkerMode(provider);
}
export const workerModeOption = z.object({ id: identifier, label: z.string() });
export const providerEntrySchema = z.object({
  id: identifier, label: z.string(), available: z.boolean(), included: z.boolean(),
  workerModes: z.array(workerModeOption).nullable().optional(),
  status: z.enum(["ready", "empty", "unavailable", "error"]), modelCount: z.number().int().nonnegative().nullable(),
});
export type ProviderEntry = z.infer<typeof providerEntrySchema>;

export const catalogModelSchema = z.object({
  provider: identifier, model: identifier, label: z.string(),
  efforts: z.array(identifier), isDefault: z.boolean(),
  coordinatorMode: z.object({ id: identifier, label: z.string() }).nullable().optional(),
});
export const routePolicySchema = z.partialRecord(gradeSchema, z.array(routeChoiceSchema).min(1).max(12));
export const skillNameSchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/);
export const workspaceKindSchema = z.enum(["directory", "worktree", "checkout", "local_checkout"]);
export const workspaceChoiceSchema = z.object({
  id: identifier,
  projectId,
  title: z.string(),
  kind: workspaceKindSchema.optional(),
  branch: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
});
export const dispatchInputSchema = z.strictObject({
  projectId, workspaceId: identifier, grade: workerGradeSchema,
  title: z.string().trim().min(1).max(160), prompt: z.string().trim().min(1).max(24000),
  requestKey: z.string().min(12).max(96).regex(/^[a-zA-Z0-9_-]+$/),
  expectedRoute: routeChoiceSchema, expectedModeId: identifier.optional(), needsHooks: z.boolean().optional(),
  skills: z.array(skillNameSchema).max(16).optional(),
});

// Execution-discipline skills stay active across subagents that write, debug, or review code.
// Orchestration skills (e.g. architect, arena, interrogate, swarm, writing-plans, how) and any
// unclassified skills remain main-session only so subagents do not trigger recursive fan-out.
export const PROPAGATED_DISCIPLINE_SKILLS = new Set<string>([
  "ponytail", "ponytail-audit", "ponytail-review", "ponytail-debt", "ponytail-gain", "ponytail-help",
  "systematic-debugging", "test-driven-development", "receiving-code-review", "blast-radius",
]);

export function isPropagatedDisciplineSkill(name: string): boolean {
  return name === "ponytail" || name.startsWith("ponytail-") || PROPAGATED_DISCIPLINE_SKILLS.has(name);
}

export function normalizeWorkerSkills(skills?: readonly string[]): string[] {
  if (!skills?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of skills) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function partitionWorkerSkills(skills?: readonly string[]): { all: string[]; mainOnly: string[]; propagated: string[] } {
  const all = normalizeWorkerSkills(skills);
  const mainOnly: string[] = [];
  const propagated: string[] = [];
  for (const name of all) {
    if (isPropagatedDisciplineSkill(name)) propagated.push(name);
    else mainOnly.push(name);
  }
  return { all, mainOnly, propagated };
}

export function buildWorkerSkillSystemPrompt(skills?: readonly string[]): string | undefined {
  const { all, mainOnly, propagated } = partitionWorkerSkills(skills);
  if (!all.length) return undefined;
  const skillPath = (name: string) => `~/.agents/skills/${name}/SKILL.md`;
  const lines = [
    "[코디네이터 배정 스킬]",
    "작업을 시작하기 전에 아래 스킬의 SKILL.md를 먼저 읽고 절차를 따르세요:",
    ...all.map(name => `- ${name}: ${skillPath(name)}`),
  ];
  if (propagated.length) {
    lines.push(
      "",
      "[하위 에이전트 전파 의무 — 실행 규율 스킬]",
      "Paseo `create_agent` 또는 하네스 내장 서브에이전트(`Agent`, `spawn_agent`, `invoke_subagent`)로 하위 작업을 위임할 때, 아래 실행 규율 스킬 경로를 하위 에이전트 프롬프트 첫머리에 반드시 함께 전달해 먼저 읽고 따르게 하세요:",
      ...propagated.map(name => `- ${name}: ${skillPath(name)}`),
    );
  }
  if (mainOnly.length) {
    lines.push(
      "",
      "[메인 세션 전용 — 하위 전파 제외]",
      `아래 스킬은 이 메인 작업자 세션에서만 수행하고 하위 서브에이전트에는 전파하지 마세요(재귀 위임·중복 방지): ${mainOnly.join(", ")}`,
    );
  }
  return lines.join("\n");
}

export type Grade = z.infer<typeof gradeSchema>;
export type WorkerGrade = z.infer<typeof workerGradeSchema>;
export type RouteChoice = z.infer<typeof routeChoiceSchema>;
export type CatalogModel = z.infer<typeof catalogModelSchema>;
export type RoutePolicy = z.infer<typeof routePolicySchema>;
export type WorkspaceChoice = z.infer<typeof workspaceChoiceSchema>;
export type DispatchInput = z.infer<typeof dispatchInputSchema>;

function primary(provider: string) {
  return provider === "claude" || provider === "codex";
}

export function eligibleProvider(grade: Grade, provider: string, needsHooks = false, catalog?: readonly CatalogModel[]) {
  if (needsHooks && !primary(provider)) return false;
  if (grade === "M") {
    if (!catalog) return primary(provider);
    // Old catalogs omitted mode discovery for Claude Code and Codex.
    return catalog.some(m => m.provider === provider && (!!m.coordinatorMode || (m.coordinatorMode === undefined && primary(m.provider))));
  }
  if (grade === "C" && provider === "grok") {
    return !!catalog && !catalog.some(m => m.provider !== "grok");
  }
  return true;
}

export function sameRoute(a: RouteChoice, b: RouteChoice) {
  return a.provider === b.provider && a.model === b.model && a.effort === b.effort;
}

type Recommendation = [provider: string, model: string, effort: string];
const recommendations: Record<Grade, Recommendation[]> = {
  A: [["claude", "claude-fable-5-2", "xhigh"], ["claude", "claude-opus-5-5", "max"], ["codex", "gpt-6.2-astra", "xhigh"]],
  B: [["claude", "claude-fable-5-2", "high"], ["claude", "claude-opus-5-5", "xhigh"], ["codex", "gpt-6.2-astra", "high"]],
  C: [["claude", "claude-opus-5-5", "high"], ["codex", "gpt-6.2-sol", "high"], ["claude", "claude-sonnet-5-5", "high"]],
  D: [["claude", "claude-sonnet-5-5", "medium"], ["codex", "gpt-6-luna", "high"]],
  M: [["claude", "claude-opus-5-5", "high"], ["codex", "gpt-6.2-sol", "high"]],
};

function available(choice: RouteChoice, catalog: CatalogModel[]) {
  return catalog.some(m => m.provider === choice.provider && m.model === choice.model &&
    (choice.effort === null || m.efforts.includes(choice.effort)));
}

export function includedCatalog(catalog: CatalogModel[], excludedProviders: readonly string[]) {
  const excluded = new Set(excludedProviders);
  return catalog.filter(m => !excluded.has(m.provider));
}

export function validateCandidates(grade: Grade, candidates: RouteChoice[], catalog: CatalogModel[], saved: RouteChoice[] = []) {
  const seen: RouteChoice[] = [];
  for (const choice of candidates) {
    const retained = saved.some(prior => sameRoute(prior, choice));
    if (!retained && (!eligibleProvider(grade, choice.provider, false, catalog) || !available(choice, catalog))) {
      throw new Error("이 등급과 호스트에서 사용할 수 있는 실행기·모델·추론 강도를 선택해 주세요.");
    }
    if (seen.some(prior => sameRoute(prior, choice))) throw new Error("같은 배정 후보가 두 번 있습니다.");
    seen.push(choice);
  }
}

export function resolveRoute(grade: Grade, policy: RoutePolicy, catalog: CatalogModel[], needsHooks = false, usage:readonly AccountUsage[] = []): RouteChoice | null {
  const providers = new Set(catalog.map(m => m.provider));
  for (const provider of providers) {
    if (!eligibleProvider(grade, provider, needsHooks, catalog)) providers.delete(provider);
  }
  const allowed = catalog.filter(m => providers.has(m.provider));
  const overrides = policy[grade];
  if (overrides) return overrides.find(choice => available(choice, allowed)) ?? null;
  const choices: RouteChoice[] = [];
  for (const [provider, model, effort] of recommendations[grade]) {
    const match = allowed.find(m => m.provider === provider && m.model === model);
    if (match) choices.push({provider,model,effort:match.efforts.includes(effort) ? effort : null});
  }
  const seen = new Set(choices.map(choice => choice.provider));
  for (const model of [...allowed.filter(m => m.isDefault),...allowed]) {
    if (seen.has(model.provider)) continue;
    seen.add(model.provider);
    const effort = grade !== "M" && primary(model.provider) && model.efforts.includes("high") ? "high" : null;
    choices.push({provider:model.provider,model:model.model,effort});
  }
  return preferCapacity(choices,usage);
}
