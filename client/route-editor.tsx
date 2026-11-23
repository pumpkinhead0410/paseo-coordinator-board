import { useBoardLanguage, type Translate } from "./language";
import { Text, TextInput, View } from "react-native";
import { useState } from "react";
import {
  workerGradeSchema,
  sameRoute,
  type Grade,
  type RouteChoice,
} from "../shared/dispatch";
import type { Operations } from "../shared/operations";
import { holdText, readyRoute } from "../shared/route-decision";
import { Button, type Theme } from "./controls";
import { browseModels, explainEmptyRoute, koreanText, savedCandidateIssue } from "./route-options";

function gradeName(grade: Grade, t: Translate) {
  const names = {
    A: t("최상", "Highest"), B: t("높음", "High"), C: t("중간", "Medium"), D: t("기본", "Basic"), M: t("운영", "Operations"),
  };
  return grade + " · " + names[grade];
}
export function routeName(route: RouteChoice | null, t: Translate = koreanText) {
  return route ? [route.provider, route.model, route.effort].filter(Boolean).join(" / ") : t("사용 가능한 후보 없음", "No available candidate");
}
export const wrap = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 };

type Props = {
  data: Operations;
  theme: Theme;
  busy: boolean;
  save: (grade: Grade, rows: RouteChoice[], revision: number) => Promise<boolean>;
};
export function RouteEditor({ data, theme, busy, save }: Props) {
  const { t } = useBoardLanguage();
  const [grade, setGrade] = useState<Grade>("C");
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{t("작업 난이도", "Task difficulty")}</Text>
      <View style={wrap}>
        {workerGradeSchema.options.map((g) => (
          <Button
            key={g}
            theme={theme}
            label={gradeName(g, t)}
            selected={g === grade}
            onPress={() => setGrade(g)}
          />
        ))}
      </View>
      <View style={{ ...wrap, alignItems: "center" }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{t("운영 세션", "Coordinator session")}</Text>
        <Button theme={theme} label={gradeName("M", t)} selected={grade === "M"} onPress={() => setGrade("M")} />
      </View>
      {grade === "M" && <Text style={{ color: theme.colors.foregroundMuted }}>{t("M은 코디네이터를 만들거나 교체할 때 사용합니다. 현재 세션은 그대로 운영됩니다.", "M selects the model for a new or replacement coordinator. The current session keeps its model.")}</Text>}
      <CandidateList key={grade + ":" + data.revision} {...{ data, theme, busy, grade, save }} />
    </View>
  );
}
function CandidateList({ data, theme, busy, grade, save }: Props & { grade: Grade }) {
  const { t } = useBoardLanguage();
  const [rows, setRows] = useState<RouteChoice[]>(data.routing[grade] ?? []);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(6);
  const [provider, setProvider] = useState<string | null>(null);
  const [edit, setSelection] = useState<RouteChoice | null>(null);
  const color = theme.colors.foreground;
  const decision = data.routes.decisions[grade];
  const route = readyRoute(decision);
  const saved = data.routing[grade]?.length;
  const browser = browseModels(data, grade, provider, query, limit, t, route);
  const editAvailable = edit && data.catalog.some(m => m.provider === edit.provider && m.model === edit.model &&
    (edit.effort === null || m.efforts.includes(edit.effort)));
  const selection = editAvailable ? edit : route;
  const model = selection && browser.choices.find(m => m.model === selection.model && m.provider === selection.provider);
  function filter(id: string | null) {
    setProvider(id);
    setSelection(null);
    setLimit(6);
  }
  return (
    <View style={{ gap: 7 }}>
      <Text style={{ color }}>{saved ? t("저장된 배정", "Saved route") : t("로컬 Selector 배정", "Local selector route")} · {routeName(route, t)}</Text>
      {decision?.kind === "ready" && decision.why && <Text style={{ color: theme.colors.foregroundMuted }}>{t("Selector가 고른 이유", "Selector reason")} · {decision.why}</Text>}
      {!route && <Text style={{ color: theme.colors.foregroundMuted }}>{decision?.kind === "held" && decision.source === "selector" ? holdText(decision.hold, t) : explainEmptyRoute(data, grade, t)}</Text>}
      {rows.map((r, i) => {
        const issue = savedCandidateIssue(data, grade, r, t);
        return (
          <View key={JSON.stringify(r)} style={wrap}>
            <Text style={{ color }}>
              {i === 0 ? t("우선", "Primary") : t(`예비 ${i}`, `Fallback ${i}`)} · {routeName(r, t)}{issue ? " · " + issue : ""}
            </Text>
            {i > 0 && (
              <Button
                theme={theme}
                label={t("앞으로", "Move up")}
                disabled={busy}
                onPress={() => {
                  const next = [...rows];
                  [next[i - 1], next[i]] = [next[i], next[i - 1]];
                  setRows(next);
                }}
              />
            )}
            <Button
              theme={theme}
              label={t("후보 제외", "Remove candidate")}
              disabled={busy}
              onPress={() => setRows(rows.filter((_, index) => i !== index))}
            />
          </View>
        );
      })}
      {browser.providers.length > 1 && <View style={wrap}>
        <Button theme={theme} label={t("전체 실행기", "All providers")} selected={browser.active === null} onPress={() => filter(null)} />
        {browser.providers.map(p => <Button key={p.id} theme={theme}
          label={`${p.label} · ${p.count}`}
          selected={browser.active === p.id} onPress={() => filter(p.id)} />)}
      </View>}
      <TextInput
        accessibilityLabel={t("모델 검색", "Search models")}
        placeholder={t("실행기 또는 모델 검색", "Search providers or models")}
        style={{ color, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0, borderRadius: 6, padding: 8 }}
        placeholderTextColor={theme.colors.foregroundMuted}
        value={query}
        onChangeText={(v) => {
          setQuery(v);
          setLimit(6);
          setSelection(null);
        }}
      />
      {browser.hint && <Text style={{ color: theme.colors.foregroundMuted }}>{browser.hint}</Text>}
      <View style={wrap}>
        {browser.choices.map((m) => (
          <Button
            key={JSON.stringify([m.provider, m.model])}
            theme={theme}
            label={m.provider + " / " + m.model + (route?.provider === m.provider && route.model === m.model
              ? " · " + (saved ? t("적용 중", "In use") : t("Selector 선택", "Selector pick")) : "")}
            selected={selection?.provider === m.provider && selection.model === m.model}
            onPress={() => setSelection(route?.provider === m.provider && route.model === m.model
              ? route : { provider: m.provider, model: m.model, effort: null })}
          />
        ))}
        {browser.choices.length < browser.count && (
          <Button theme={theme} label={t("모델 더 보기", "Show more models")} onPress={() => setLimit(limit + 12)} />
        )}
      </View>
      {model && selection && (
        <View style={{ gap: 6 }}>
          <Text style={{ color }}>{t("추론 강도", "Reasoning effort")}</Text>
          <View style={wrap}>
            {[null, ...model.efforts].map((e) => (
              <Button
                theme={theme}
                key={e ?? "default"}
                label={e ?? t("실행기 기본 강도", "Provider default")}
                selected={e === selection.effort}
                onPress={() => setSelection({ ...selection, effort: e })}
              />
            ))}
            <Button
              theme={theme}
              label={t("후보에 추가", "Add candidate")}
              disabled={busy || rows.length >= 12 || rows.some((r) => sameRoute(r, selection))}
              onPress={() => {
                setRows([...rows, selection]);
                setSelection(null);
              }}
            />
          </View>
        </View>
      )}
      <View style={wrap}>
        <Button
          theme={theme}
          label={t("배정표 저장", "Save routing")}
          disabled={busy || JSON.stringify(rows) === JSON.stringify(data.routing[grade] ?? [])}
          onPress={() => void save(grade, rows, data.revision)}
        />
        <Button
          theme={theme}
          label={t("Selector로 복원", "Restore selector routing")}
          disabled={busy || !data.routing[grade]}
          onPress={() => void save(grade, [], data.revision)}
        />
      </View>
    </View>
  );
}
