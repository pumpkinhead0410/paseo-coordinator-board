import { expect, test } from "bun:test";
import { browseModels, explainEmptyRoute, savedCandidateIssue } from "../client/route-options";
import type { CatalogModel, Grade, ProviderEntry, RouteChoice } from "../shared/dispatch";

function provider(id: string, extra: Partial<ProviderEntry> = {}): ProviderEntry {
  return { id, label: id, included: true, available: true, status: "ready", modelCount: 1, ...extra };
}

function model(provider: string, id: string): CatalogModel {
  return { provider, model: id, label: id, isDefault: false, efforts: ["high"] };
}

test("검색하기 전에도 실행기마다 첫 모델이 보이며, 실행기와 모델 이름으로 탐색할 수 있다", () => {
  const data = {
    providers: [provider("codex"), provider("cursor", { label: "커서 앱" }), provider("custom-cli")],
    catalog: [
      ...Array.from({ length: 20 }, (_, i) => model("codex", String(i))),
      model("cursor", "gemini"),
      model("custom-cli", "special"),
    ],
    routing: {},
  };

  const first = browseModels(data, "C", null, "", 3);
  expect(first.choices.map(m => m.provider)).toEqual(["codex", "cursor", "custom-cli"]);
  expect(first.count).toBe(22);
  expect(first.providers.map(p => p.count)).toEqual([20, 1, 1]);
  expect(browseModels(data, "C", "cursor", "", 6).choices.map(m => m.model)).toEqual(["gemini"]);
  expect(browseModels(data, "C", null, "커서", 6).choices.map(m => m.model)).toEqual(["gemini"]);
  expect(browseModels(data, "C", "cursor", "special", 6).hint).toContain("전체 실행기");
  expect(browseModels(data, "C", null, "no match", 6).hint).toContain("검색어");
  // A·B도 이제 모든 실행기를 고를 수 있다(로컬 Selector가 풀을 고른다).
  expect(browseModels(data, "B", null, "", 6).providers.map(p => p.id)).toEqual(["codex", "cursor", "custom-cli"]);
});

test("실행기 포함 여부·등급·연결 상태를 기준으로 빈 추천의 복구 방법을 표시한다", () => {
  function message(providers: ProviderEntry[], grade: Grade = "C") {
    return explainEmptyRoute({ providers, catalog: [], routing: {} }, grade);
  }
  expect(message([])).toMatch(/연결/);
  for (const grade of ["A", "B"] as const) {
    expect(message([provider("cursor", { status: "empty" })], grade)).toMatch(/모델.*없/);
  }
  expect(message([provider("cursor")], "M")).toMatch(/기존|지정/);
  expect(message([provider("codex", { included: false })], "M")).toMatch(/포함/);
  expect(message([provider("codex", { available: false, status: "unavailable" })], "D")).toMatch(/연결/);
  expect(message([provider("codex", { status: "error" })])).toMatch(/조회.*실패/);
  expect(message([provider("codex", { status: "empty", modelCount: 0 })])).toMatch(/모델.*없/);
});

test("저장 후보를 제외하거나 모델·강도 목록이 바뀌어도 원래 순위와 이유를 보여 준다", () => {
  const first: RouteChoice = { provider: "codex", model: "first", effort: "high" };
  const second: RouteChoice = { provider: "cursor", model: "gemini", effort: null };
  const data = {
    providers: [provider("codex", { included: false }), provider("cursor", { included: false })],
    catalog: [] as CatalogModel[],
    routing: { C: [first, second] },
  };

  expect(explainEmptyRoute(data, "C")).toMatch(/저장.*후보/);
  expect(savedCandidateIssue(data, "C", first)).toContain("제외");
  data.providers[0].included = true;
  expect(savedCandidateIssue(data, "C", first)).toContain("모델");
  data.catalog.push({ ...model("codex", "first"), efforts: [] });
  expect(savedCandidateIssue(data, "C", first)).toContain("강도");
  data.catalog[0].efforts = ["high"];
  expect(savedCandidateIssue(data, "C", first)).toBeNull();
  expect(data.routing.C).toEqual([first, second]);
});

test("영어 경고를 표시하면서 실행기 이름과 모델 ID를 보존한다", () => {
  const en = (_ko: string, english: string) => english;
  const a = model("codex", "팀-모델");
  const b = model("cursor", "model-B");
  const row = { provider: b.provider, model: b.model, effort: "xhigh" };
  const data = {
    providers: [provider("codex", { label: "팀 실행기" }), provider("cursor")],
    catalog: [a, b], routing: { C: [row] },
  };
  expect(savedCandidateIssue(data, "C", row, en)).toMatch(/effort/);
  expect(explainEmptyRoute(data, "C", en)).toContain("Restore selector routing");
  expect(browseModels(data, "C", "cursor", "팀", 6, en).hint).toContain("All providers");
  const found = browseModels(data, "C", null, "팀", 6, en);
  expect(found.providers[0].label).toBe("팀 실행기");
  expect(found.choices[0].model).toBe("팀-모델");
  expect(data.routing.C).toEqual([row]);
});

test("접힌 목록에도 적용할 추천이 먼저 보이고, 수동 검색과 실행기 필터는 그대로 적용된다", () => {
  const later = model("codex", "late-model");
  const data = {
    providers: [provider("codex"), provider("cursor")],
    catalog: [model("codex", "first"), model("cursor", "second"), later], routing: {},
  };
  const effective = { ...later, effort: "high" };
  const browse = (id: string | null, query: string, limit: number) => browseModels(data, "C", id, query, limit, undefined, effective);
  expect(browse(null, "", 1).choices).toEqual([later]);
  expect(browse(null, "", 20).choices.map(m => m.model)).toEqual(["late-model", "first", "second"]);
  expect(browse("cursor", "", 1).choices.map(m => m.model)).toEqual(["second"]);
  expect(browse(null, "first", 1).choices.map(m => m.model)).toEqual(["first"]);
  expect(browse(null, "missing", 5).choices).toEqual([]);
  expect(browse(null, "", 0).choices).toEqual([]);
  expect(data.catalog.map(m => m.model)).toEqual(["first", "second", "late-model"]);
});
