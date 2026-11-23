import { eligibleProvider, type CatalogModel, type Grade, type ProviderEntry, type RouteChoice } from "../shared/dispatch";
import type { Operations } from "../shared/operations";
import type { Translate } from "./language";

export const koreanText: Translate = ko => ko;

type ModelDirectory = Pick<Operations, "providers" | "catalog" | "routing">;

export function savedCandidateIssue(data: ModelDirectory, grade: Grade, row: RouteChoice, t: Translate = koreanText) {
  const p = data.providers.find(p => p.id === row.provider);
  if (!p) return t("Paseo 목록에 없는 실행기", "Provider missing from Paseo");
  if (!p.included) return t("배정에서 제외한 실행기", "Provider excluded from routing");
  if (!eligibleProvider(grade, p.id, false, data.catalog)) return t("이 등급에서 허용하지 않는 실행기", "Provider ineligible for this grade");
  if (!p.available || p.status === "unavailable") return t("연결을 확인할 실행기", "Check the provider connection");
  if (p.status === "error") return t("모델 조회 실패", "Model lookup failed");
  if (p.status === "empty") return t("선택할 모델 없음", "No models available");
  const model = data.catalog.find(m => m.provider === row.provider && m.model === row.model);
  if (!model) return t("현재 목록에 없는 모델", "Model missing from the current catalog");
  if (row.effort !== null && !model.efforts.includes(row.effort)) return t("현재 지원하지 않는 추론 강도", "Reasoning effort no longer supported");
  return null;
}

export function explainEmptyRoute(data: ModelDirectory, grade: Grade, t: Translate = koreanText) {
  const saved = data.routing[grade];
  if (saved?.length) {
    const problems = [...new Set(saved.map(row => savedCandidateIssue(data, grade, row, t)).filter(Boolean))];
    return t(`저장된 후보를 사용할 수 없습니다 (${problems.join(", ")}). 실행기 설정을 확인하거나, 다른 후보를 추가해 저장하거나 ‘Selector로 복원’을 선택하세요.`,
      `Saved candidates are unavailable (${problems.join(", ")}). Check provider settings, save another candidate, or choose Restore selector routing.`);
  }
  if (!data.providers.length) return t("Paseo에서 실행기를 연결한 뒤 목록을 새로 고쳐 주세요.", "Connect a provider in Paseo, then refresh the catalog.");
  const eligible = data.providers.filter(p => eligibleProvider(grade, p.id, false, data.catalog) ||
    (grade === "M" && (!p.included || !p.available || p.status !== "ready") && ["claude", "codex", "antigravity", "opencode", "copilot"].includes(p.id)));
  if (!eligible.length) {
    if (grade === "M") {
      return t("코디네이터용 도구와 권한 모드를 확인할 수 없습니다. Claude Code, Codex, Antigravity, OpenCode 또는 Copilot 연결을 확인하거나, 설정에서 Paseo MCP를 사용하는 기존 세션을 코디네이터로 지정하세요.", "No verified coordinator mode is available. Check the connection to Claude Code, Codex, Antigravity, OpenCode or Copilot, or designate an existing session with Paseo MCP in Settings.");
    }
    return t("연결된 실행기의 허용 등급을 확인하고, 이 작업을 맡을 실행기를 Paseo에 연결하세요.", "Check the grades supported by your providers, then connect an eligible provider in Paseo.");
  }
  const included = eligible.filter(p => p.included);
  const disabled = eligible.filter(p => !p.included);
  const notes: string[] = [];
  const names = (list: ProviderEntry[]) => list.map(p => p.label).join(", ");
  const groups = [
    { list: included.filter(p => !p.available || p.status === "unavailable"), action: t("Paseo에서 실행기 연결을 확인하세요.", "Check the provider connection in Paseo.") },
    { list: included.filter(p => p.available && p.status === "error"), action: t("모델 조회에 실패했습니다. 목록을 새로 고쳐 주세요.", "Model lookup failed. Refresh the catalog.") },
    { list: included.filter(p => p.available && p.status === "empty"), action: t("선택할 모델이 없습니다. Paseo에서 모델 설정을 확인하세요.", "No models are available. Check model settings in Paseo.") },
    { list: disabled, action: t("배정에서 제외되어 있습니다. ‘Paseo 실행기’에서 사용할 실행기를 다시 포함하세요.", "Excluded from routing. Include this provider under Paseo providers.") },
  ];
  for (const { list, action } of groups) {
    if (list.length) notes.push(`${names(list)} · ${action}`);
  }
  return notes.join("\n") || t("이 등급에 사용할 수 있는 모델이 없습니다. 실행기와 모델 목록을 새로 고쳐 주세요.", "No models are available for this grade. Refresh the providers and model catalog.");
}

// Preserve each provider's catalog order and give every provider a first result before its second.
export function browseModels(data: ModelDirectory, grade: Grade, providerId: string | null, query: string, limit: number, t: Translate = koreanText, activeRoute: RouteChoice | null = null) {
  const byProvider = new Map(data.providers
    .filter(p => p.included && p.available && p.status === "ready" && eligibleProvider(grade, p.id, false, data.catalog))
    .map(p => [p.id, { id: p.id, label: p.label, models: [] as CatalogModel[] }]));
  for (const model of data.catalog) byProvider.get(model.provider)?.models.push(model);
  const groups = [...byProvider.values()].filter(p => p.models.length > 0);
  const providers = groups.map(p => ({
    id: p.id,
    label: groups.some(other => other.id !== p.id && other.label === p.label) ? `${p.label} (${p.id})` : p.label,
    count: p.models.length,
  }));
  const active = providers.some(p => p.id === providerId) ? providerId : null;
  const search = query.trim().toLowerCase();
  const matches = groups.map(p => ({
    id: p.id,
    models: p.models.filter(m => [m.provider, p.label, m.model, m.label].join(" ").toLowerCase().includes(search)),
  }));
  const visible = matches.filter(p => !active || active === p.id);
  const count = visible.reduce((sum, p) => sum + p.models.length, 0);
  const choices: CatalogModel[] = [];
  const wanted = Math.min(count, limit);
  // Only pin the effective route when it matches the active filter and search.
  const routeGroup = visible.find(p => p.id === activeRoute?.provider);
  const routeIndex = routeGroup?.models.findIndex(m => m.model === activeRoute?.model) ?? -1;
  if (routeGroup && routeIndex >= 0 && wanted > 0) choices.push(...routeGroup.models.splice(routeIndex, 1));
  for (let i = 0; choices.length < wanted; i++) {
    for (const p of visible) {
      if (p.models[i]) choices.push(p.models[i]);
      if (choices.length === wanted) break;
    }
  }
  let hint: string | null = null;
  if (search && providers.length && !count) {
    hint = active && matches.some(p => p.id !== active && p.models.length)
      ? t("다른 실행기에 검색 결과가 있습니다. ‘전체 실행기’를 선택하세요.", "Other providers have matches. Select All providers.")
      : t("검색 결과가 없습니다. 모델 ID로 검색하거나 검색어를 지워 주세요.", "No matches. Search by model ID or clear your search.");
  }
  return { providers, active, count, choices, hint };
}
