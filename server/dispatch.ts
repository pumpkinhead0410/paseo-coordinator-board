import { createHash } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { reportingKey } from "../shared/contract";
import {
  buildWorkerSkillSystemPrompt, dispatchInputSchema, partitionWorkerSkills,
  type CatalogModel, type DispatchInput, type ProviderEntry, type RouteChoice, type RoutePolicy, type WorkspaceChoice,
} from "../shared/dispatch";
import { holdText, koreanOnly } from "../shared/route-decision";
import { readPages } from "./discovery";
import { createRouter, routingFingerprint, type Router } from "./routes";

export { validateCandidates } from "../shared/dispatch";

type Sdk = PluginHandlerContext["paseo"];
type PaseoWorkspace = Awaited<ReturnType<Sdk["workspaces"]["list"]>>["entries"][number];
type PaseoAgentConfig = Parameters<Sdk["agents"]["create"]>[0]["config"];
type DispatchScope = { projects: string[]; routing: RoutePolicy; coordinator: string | null; excludedProviders: string[]; usageRouting?: boolean; workerModeOverrides?: Record<string,string> };
type Directory = { providers: Omit<ProviderEntry, "included">[]; catalog: CatalogModel[] };

// Only built-in adapters with a known permission contract and a Paseo tool transport.
// ACP mode names are provider-specific; a custom "agent" or "auto" is not evidence.
// Antigravity is deliberately absent: the AGY CLI enables only the smallest Paseo MCP tools that fit its
// per-session tool budget, so most board tools (plan/assign/classify) are unavailable to an AGY coordinator.
const coordinatorModes = new Map<string, string[]>([
  ["claude", ["auto", "default"]],
  ["codex", ["auto-review", "auto"]],
  ["copilot", ["https://agentclientprotocol.com/protocol/session-modes#agent"]],
  ["opencode", ["build"]],
]);

type ProviderMode = NonNullable<Awaited<ReturnType<Sdk["providers"]["listModes"]>>["modes"]>[number];

async function readModes(paseo: Pick<Sdk, "providers">, provider: string, cwd?: string): Promise<ProviderMode[] | null> {
  try {
    const result = await paseo.providers.listModes(provider, cwd ? { cwd } : undefined);
    return !result.error && Array.isArray(result.modes) ? result.modes : null;
  } catch {
    return null;
  }
}

function coordinatorModeOf(provider: string, modes: ProviderMode[] | null) {
  for (const id of coordinatorModes.get(provider) ?? []) {
    const mode = modes?.find(m => m.id === id && m.colorTier !== "dangerous");
    if (mode) return { id, label: mode.label };
  }
  return null;
}

function workerModesOf(provider: string, modes: ProviderMode[] | null) {
  return modes?.filter(mode => {
    if (provider === "codex" && mode.id === "full-access") return true;
    return mode.colorTier !== "dangerous" && mode.id !== "bypassPermissions";
  }).map(({id, label}) => ({id, label})) ?? null;
}

export async function requireWorkerMode(paseo: Pick<Sdk, "providers">, provider: string, id: string, cwd?: string) {
  const modes = workerModesOf(provider, await readModes(paseo, provider, cwd));
  if (!modes?.some(mode => mode.id === id))
    throw new Error(`${provider} 작업 권한 모드 '${id}'를 확인할 수 없습니다. 설정에서 사용할 수 있는 작업 권한을 선택하세요.`);
}

export async function readProviderAvailability(paseo: Pick<Sdk, "providers">) {
  try {
    const result = await paseo.providers.listAvailable();
    if (!result.error) return result.providers;
  } catch {
    // RPC diagnostics may contain local paths or configuration details.
  }
  throw new Error("호스트의 실행기 목록을 확인하지 못했습니다.");
}

export async function readProviderDirectory(paseo: Pick<Sdk, "providers">, cwd?: string, withLabels = false, withCoordinatorModes = false): Promise<Directory> {
  const [availability, labels] = await Promise.all([
    readProviderAvailability(paseo),
    withLabels ? paseo.providers.snapshot().then(s => new Map(s.entries.map(e => [e.provider, e.label]))).catch(() => null) : null,
  ]);
  const rows = await Promise.all(availability.map(async ({ provider, available, error }) => {
    const info: Omit<ProviderEntry, "included"> = {
      id: provider, label: labels?.get(provider)?.trim() || provider, available,
      status: available ? "error" : "unavailable", modelCount: null,
    };
    const models: CatalogModel[] = [];
    if (available && !error) {
      try {
        const result = await paseo.providers.listModels(provider, cwd ? { cwd } : undefined);
        if (!result.error && Array.isArray(result.models)) {
          const modes = withCoordinatorModes && (withLabels || coordinatorModes.has(provider)) && result.models.some(m => m.isSelectable !== false)
            ? await readModes(paseo, provider, cwd) : null;
          const coordinatorMode = coordinatorModeOf(provider, modes);
          if (withLabels && withCoordinatorModes) info.workerModes = workerModesOf(provider, modes);
          for (const model of result.models) {
            if (model.isSelectable === false) continue;
            models.push({
              provider, model: model.id, label: model.label, isDefault: !!model.isDefault,
              // Cursor exposes effort variants as selectable model IDs.
              efforts: provider === "cursor" ? [] : (model.thinkingOptions ?? []).map(option => option.id),
              ...(withCoordinatorModes ? { coordinatorMode } : {}),
            });
          }
          info.modelCount = models.length;
          info.status = models.length ? "ready" : "empty";
        }
      } catch {
        // Keep this provider visible with unknown count; other providers still work.
      }
    }
    return { info, models };
  }));
  return { providers: rows.map(row => row.info), catalog: rows.flatMap(row => row.models) };
}

export async function readCatalog(paseo: Pick<Sdk, "providers">, cwd?: string, withCoordinatorModes = false) {
  const directory = await readProviderDirectory(paseo, cwd, false, withCoordinatorModes);
  const available = directory.providers.filter(p => p.available);
  if (available.length && available.every(p => p.status === "error"))
    throw new Error("이 호스트의 모델 목록을 읽지 못했습니다. 연결을 확인하고 다시 시도해 주세요.");
  return directory.catalog;
}

export function configForRoute(choice: RouteChoice): PaseoAgentConfig {
  return {
    provider: choice.provider + "/" + choice.model,
    ...(choice.effort !== null ? { thinkingOptionId: choice.effort } : {}),
  };
}

function usable(workspace: PaseoWorkspace) {
  return !workspace.internal && !workspace.background && !workspace.archivingAt && !!workspace.workspaceDirectory &&
    (!workspace.setupStatus || workspace.setupStatus === "completed");
}

export async function readManagedWorkspaces(paseo: Pick<Sdk, "workspaces">, projects: string[]): Promise<WorkspaceChoice[]> {
  if (!projects.length) return [];
  const rows = await readPages<PaseoWorkspace>(page => paseo.workspaces.list({
    filter: { includeBackground: false }, sort: [{ key: "project_id", direction: "asc" }], page,
  }));
  return rows.filter(w => usable(w) && projects.includes(w.projectId)).map(w => ({
    id: w.id, projectId: w.projectId, title: w.title?.trim() || w.name,
  }));
}

// A caller-chosen UUID keeps old hosts from silently falling back to unkeyed create-and-prompt.
function creationUuid(key: string, kind: "agent" | "prompt") {
  const bytes = createHash("sha256").update("coordinator-board/dispatch/" + kind + "/" + key).digest();
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

const fingerprintKey = "coordinator-board/dispatch-intent";
const parentKey = "coordinator-board/dispatch-parent";
const modeKey = "coordinator-board/dispatch-mode";

export async function dispatchWorker(paseo: Pick<Sdk, "agents" | "workspaces" | "providers">, request: DispatchInput, getScope: () => DispatchScope, router: Router = createRouter()) {
  const input = dispatchInputSchema.parse(request);
  const scopeForProject = () => {
    const state = getScope();
    if (typeof state.coordinator !== "string" || !state.coordinator) throw new Error("현재 기기의 코디네이터를 먼저 지정해 주세요.");
    if (!state.projects.includes(input.projectId)) throw new Error("이 호스트에서 관리할 프로젝트를 먼저 선택해 주세요.");
    return { workerModeOverrides: state.workerModeOverrides ?? {}, coordinator: state.coordinator, routing: state.routing, excluded: state.excludedProviders };
  };
  const initial = scopeForProject();
  const skillPlan = partitionWorkerSkills(input.skills);
  const skillPrompt = buildWorkerSkillSystemPrompt(skillPlan.all);
  const sessionId = creationUuid(input.requestKey, "agent");
  const fingerprint = createHash("sha256").update(JSON.stringify([
    input.projectId, input.workspaceId, input.grade, input.title, input.prompt, !!input.needsHooks,
    input.expectedRoute.provider, input.expectedRoute.model, input.expectedRoute.effort,
    ...(skillPlan.all.length ? [skillPlan.all] : []),
  ])).digest("hex");
  const workspace = paseo.workspaces.ref(input.workspaceId);
  const [target, receipt] = await Promise.all([workspace.refresh(), paseo.agents.ref(sessionId).refresh()]);
  if (!target || target.id !== input.workspaceId || target.projectId !== input.projectId || !usable(target)) {
    throw new Error("선택한 프로젝트에서 작업 가능한 워크스페이스를 다시 골라 주세요.");
  }
  let parent: string;
  let modeId: string | undefined;
  const route = input.expectedRoute;
  if (receipt) {
    scopeForProject();
    if (receipt.agent.id !== sessionId || receipt.agent.workspaceId !== target.id || receipt.agent.metadata?.[fingerprintKey] !== fingerprint) {
      throw new Error("이미 다른 작업에 사용한 요청입니다. 새 작업으로 시작해 주세요.");
    }
    const previousParent = receipt.agent.metadata[parentKey];
    if (typeof previousParent !== "string" || !previousParent) throw new Error("기존 작업의 상위 세션을 확인할 수 없습니다.");
    parent = previousParent;
    const previousMode = receipt.agent.metadata[modeKey];
    if (typeof previousMode === "string") modeId = previousMode;
    // An agent snapshot alone does not confirm that its initial prompt was accepted.
    // Replay the original creation key/payload so the daemon settles that operation.
  } else {
    const routingScope = (state: typeof initial) => ({ routing: state.routing, excludedProviders: state.excluded, workerModeOverrides: state.workerModeOverrides });
    const catalog = await readCatalog(paseo, target.workspaceDirectory);
    // 확정된 경로가 지금도 배정 가능한지만 확인합니다. 다른 경로로 바꿔 배정하지 않습니다.
    const decision = await router.confirm(input.grade, route, { scope: routingScope(initial), catalog, needsHooks: input.needsHooks });
    if (decision.kind === "held") throw new Error(holdText(decision.hold, koreanOnly));
    modeId = decision.modeId;
    if (modeId) await requireWorkerMode(paseo, route.provider, modeId, target.workspaceDirectory);
    const state = scopeForProject();
    if (routingFingerprint(routingScope(state), input.grade, route.provider) !== routingFingerprint(routingScope(initial), input.grade, route.provider))
      throw new Error("배정 설정이 바뀌었습니다. 미리보기를 다시 확인해 주세요.");
    parent = state.coordinator;
  }
  if (input.expectedModeId !== undefined && input.expectedModeId !== modeId)
    throw new Error("작업 권한이 배정 미리보기와 다릅니다. 호스트 설정을 다시 확인해 주세요.");
  const worker = await workspace.agents.create({
    agentId: sessionId, idempotencyKey: "coordinator-board/worker/" + input.requestKey,
    clientMessageId: creationUuid(input.requestKey, "prompt"),
    parent,
    config: { ...configForRoute(route), ...(modeId && { modeId }), ...(skillPrompt && { systemPrompt: skillPrompt }) }, title: input.title, prompt: input.prompt,
    metadata: {
      [reportingKey]: true, [fingerprintKey]: fingerprint, "coordinator-board/grade": input.grade,
      [parentKey]: parent, ...(modeId && { [modeKey]: modeId }),
      ...(skillPlan.all.length && {
        "coordinator-board/skills": skillPlan.all,
        "coordinator-board/propagated-skills": skillPlan.propagated,
      }),
    },
  });
  if (worker.id !== sessionId || worker.workspaceId !== target.id) throw new Error("생성된 세션과 대상 워크스페이스가 일치하는지 확인해 주세요.");
  if (modeId) {
    const agent = (await paseo.agents.ref(sessionId).refresh())?.agent;
    if (agent?.currentModeId !== modeId)
      throw new Error(`작업 세션 ${sessionId}을 만들었지만 요청한 권한 '${modeId}'를 확인할 수 없습니다. 기존 세션에서 권한을 확인하세요.`);
  }
  return { sessionId, route, ...(modeId && { modeId }), ...(skillPlan.all.length && { skills: skillPlan.all }) };
}
