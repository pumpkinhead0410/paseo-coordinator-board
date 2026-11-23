import { useRpc } from "@getpaseo/plugin/client";
import { SendButton, SendTextInput } from "./send-input";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, useWindowDimensions, View } from "react-native";
import {
  askDigest,
  operationState,
  requestWork,
  setupCoordinator,
  setProviderInclusion,
  setWorkerMode,
  updateRouting,
  type Operations,
} from "../shared/operations";
import { holdText, readyRoute } from "../shared/route-decision";
import { Button, SessionChip, type Theme } from "./controls";
import { PhotoComposer, usePhotoDraft } from "./photo-composer";
import { UsageRouting } from "./usage-routing";
import { ProviderSettings } from "./providers";
import { FactReplyControls } from "./fact-reply-controls";
import { CoordinatorPinControls } from "./coordinator-pin";
import { RouteEditor, routeName, wrap } from "./route-editor";
import { useBoardLanguage } from "./language";
import { explainEmptyRoute } from "./route-options";

type Props = {
  theme: Theme;
  settings: boolean;
  coordinator: string | null;
  configured: boolean;
  refreshBoard: () => void;
  openCoordinator?: (id: string) => void;
};

export function OperationsPanel({ theme, settings, coordinator, configured, refreshBoard, openCoordinator }: Props) {
  const { t, language } = useBoardLanguage();
  const fetchState = useRpc(operationState),
    setup = useRpc(setupCoordinator),
    includeProvider = useRpc(setProviderInclusion),
    saveWorkerMode = useRpc(setWorkerMode),
    savePolicy = useRpc(updateRouting);
  const sendWork = useRpc(requestWork),
    sendDigest = useRpc(askDigest);
  const [confirm, setConfirm] = useState(false);
  const [data, setData] = useState<Operations | null>(null);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [text, setText] = useState("");
  const [editorExpanded, setEditorExpanded] = useState(false);
  const { height: windowHeight } = useWindowDimensions();
  const photoDraft = usePhotoDraft();
  const hasRequest = Boolean(text.trim() || photoDraft.photos.length);
  const sendRequest = { disabled: busy || !configured || !hasRequest || photoDraft.blocked, onPress: () => void post("work") };
  const [inputFocused, setInputFocused] = useState(false);
  const [feedbackArea, setFeedbackArea] = useState<"provider" | "routing" | "coordinator">("provider");
  const pending = useRef(false),
    live = useRef(false),
    generation = useRef(0);
  const delivery = useRef({ work: { payload: "", key: "" }, digest: { payload: "", key: "" } });
  const fetchRef = useRef(fetchState);
  fetchRef.current = fetchState;
  const refresh = useCallback(async (clearError = true, setupPreview = false) => {
    const token = ++generation.current;
    setLoading(true);
    try {
      // An older daemon may still accept only the original empty input.
      const result = setupPreview ? await fetchRef.current({ view: "setup" }).catch(error => {
        if (!/unrecognized[_ ]keys?|invalid (?:rpc )?input|unexpected key/i.test(String(error))) throw error;
        return fetchRef.current({});
      }) : await fetchRef.current({});
      if (live.current && token === generation.current) {
        setData(result);
        if (clearError) setError("");
      }
    } catch (e) {
      if (live.current && token === generation.current) {
        setFeedbackArea("provider");
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (live.current && token === generation.current) setLoading(false);
    }
  }, []);
  const needsModels = settings || (configured && !coordinator);
  // 사용량 갱신은 기다리지 않고 응답하므로, 갱신 중이면 한 번만 다시 조회합니다.
  const followUp = useRef(false);
  useEffect(() => {
    if (followUp.current) { followUp.current = false; return; }
    if (!data?.routes.refreshing) return;
    const timer = setTimeout(() => { followUp.current = true; void refresh(false, !settings); }, 5000);
    return () => clearTimeout(timer);
  }, [data, settings, refresh]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (needsModels) void refresh(true, !settings);
  }, [needsModels, settings, refresh]);
  useEffect(() => {
    setConfirm(false);
    delivery.current = { work: { payload: "", key: "" }, digest: { payload: "", key: "" } };
  }, [coordinator]);
  useEffect(() => {
    setConfirm(false);
    setNotice("");
    setError("");
  }, [settings, language]);
  async function act<T>(fn: () => Promise<T>, done: string, area: typeof feedbackArea = "coordinator"): Promise<T | null> {
    if (pending.current) return null;
    pending.current = true;
    setBusy(true);
    setFeedbackArea(area);
    setError("");
    setNotice("");
    try {
      const value = await fn();
      if (live.current) {
        refreshBoard();
        setNotice(done);
      }
      return value;
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function post(kind: "digest" | "work") {
    if (!coordinator || pending.current || (kind === "work" ? photoDraft.blocksSubmit() : photoDraft.readPending.current)) return;
    const images = photoDraft.latest.current;
    const message = text.trim();
    if (kind === "work" && !message && !images.length) return;
    const payload = JSON.stringify(kind === "digest" ? [coordinator, language] : [coordinator, message, images.map(photo => photo.id)]);
    if (delivery.current[kind].payload !== payload)
      delivery.current[kind] = {
        payload,
        key: "board-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2),
      };
    const input = { coordinator, requestKey: delivery.current[kind].key };
    const receipt = await act(
      async () => {
        const result = kind === "digest" ? await sendDigest({ ...input, language, handleBoardFacts: true })
          : await sendWork({ ...input, text: message, ...(images.length > 0 && { images: images.map(photo => photo.image) }) });
        if (!result.ok) throw Error(t("전송을 확인하지 못했습니다. 다시 시도해 주세요.", "Delivery was not confirmed. Please retry."));
        return result;
      },
      kind === "digest"
        ? t("다이제스트를 요청했습니다. 코디네이터 세션에서 답을 확인하세요.", "Digest requested. Open the coordinator session to read the response.")
        : images.length
          ? t(`사진 ${images.length}장과 함께 코디네이터에게 요청을 보냈습니다.`, `Sent the request to the coordinator with ${images.length} photo${images.length === 1 ? "" : "s"}.`)
          : t("첨부 없이 코디네이터에게 요청을 보냈습니다.", "Sent the request to the coordinator without attachments."),
    );
    if (receipt && live.current) {
      delivery.current[kind] = { payload: "", key: "" };
      if (kind === "work") {
        setText("");
        setEditorExpanded(false);
        photoDraft.clear();
      }
    }
  }
  if (!settings && !configured && !coordinator) return null;
  const decision = data?.routes.decisions.M;
  const model = readyRoute(decision);
  const missingModel = data && (decision?.kind === "held" && decision.source === "selector" ? holdText(decision.hold, t) : explainEmptyRoute(data, "M", t));
  const mode = data?.coordinatorMode;
  const modeText = mode ? t(`도구 권한 · ${mode.label}`, `Tool permissions · ${mode.label}`) : t("권한 모드를 확인할 수 없습니다. 설정에서 실행기·모델을 새로 고쳐 주세요.", "Permission mode unavailable. Refresh providers and models in Settings.");
  const color = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;
  const section = { gap: 10, backgroundColor: theme.colors.surface1, padding: 14, borderRadius: 10 };
  const heading = { color, fontWeight: "600" as const, fontSize: 17 };
  const feedback = <>
    {!!error && <Text accessibilityLiveRegion="polite" selectable style={{ color: theme.colors.statusDanger }}>{error}</Text>}
    {!!notice && <Text accessibilityLiveRegion="polite" style={{ color }}>{notice}</Text>}
  </>;

  function connect() {
    if (!model || !mode || !configured) return;
    void act(
      () => setup({ expectedCoordinator: coordinator, replace: !!coordinator, expectedRoute: model, expectedModeId: mode.id }),
      t("운영 세션을 연결했습니다.", "Coordinator session connected."),
    ).then((result) => {
      if (result && live.current) {
        setConfirm(false);
        if (result.pinFailed) setNotice(t("운영 세션을 연결했습니다. 사이드바 고정은 설정에서 다시 시도해 주세요.", "Coordinator connected. Retry sidebar pinning in Settings."));
      }
    });
  }

  if (settings) return <View style={{ gap: 14 }}>
    <FactReplyControls theme={theme} />
    <CoordinatorPinControls theme={theme} coordinator={coordinator} />
    <View style={section}>
      <View style={{ ...wrap, alignItems: "center", justifyContent: "space-between" }}>
        <Text accessibilityRole="header" style={heading}>{t("Paseo 실행기", "Paseo providers")}</Text>
        <Button theme={theme} label={loading ? t("실행기 조회 중…", "Loading providers\u2026") : t("실행기·모델 새로 고침", "Refresh providers and models")} disabled={loading || busy} onPress={() => void refresh()} />
      </View>
      <Text style={{ color: muted }}>{t("새로 발견한 실행기는 기본으로 포함됩니다. 연결된 모델이 있는 실행기에 작업을 배정합니다.", "New providers are included by default. Providers with available models can receive assignments.")}</Text>
      {data && <ProviderSettings theme={theme} providers={data.providers} catalog={data.catalog} busy={busy || loading}
        overrides={data.workerModeOverrides}
        setMode={async (provider, modeId) => {
          const result = await act(() => saveWorkerMode({ provider, modeId, expectedRevision: data.revision }),
            t("다음 작업 세션의 권한을 저장했습니다.", "Saved permissions for new worker sessions."), "provider");
          if (live.current) await refresh(!!result);
        }}
        change={async (provider, included) => {
        const result = await act(() => includeProvider({ provider, included, expectedRevision: data.revision }),
          included ? t("이 실행기를 새 작업 배정에 포함했습니다.", "Provider included in new assignments.") : t("이 실행기를 새 작업 배정에서 제외했습니다.", "Provider excluded from new assignments."), "provider");
        if (live.current) await refresh(!!result);
      }} />}
      {feedbackArea === "provider" && feedback}
    </View>
    {data && <UsageRouting theme={theme} providers={data.providers} reports={data.usage ?? []} supplemental={data.displayUsage} />}
    <View style={section}>
      <Text accessibilityRole="header" style={heading}>{t("모델 배정", "Model routing")}</Text>
      <Text style={{ color: muted }}>{t("등급별 모델은 이 호스트의 로컬 Selector가 고릅니다. 직접 정하려면 후보를 원하는 순서대로 저장하세요. 저장한 순서가 Selector보다 우선합니다.", "The local selector on this host picks each grade's model. To customize a grade, save its models in order of preference. A saved order takes precedence over the selector.")}</Text>
      {data && <RouteEditor
        data={data}
        theme={theme}
        busy={busy || loading}
        save={async (grade, candidates, expectedRevision) => {
          const result = await act(
            () => savePolicy({ grade, candidates, expectedRevision }),
            grade === "M" ? t("운영 세션 모델을 저장했습니다. 다음 생성 또는 교체부터 적용됩니다.", "Coordinator model saved for the next creation or replacement.") : t("배정표를 저장했습니다. 다음 배정부터 적용됩니다.", "Routing saved for the next assignment."),
            "routing",
          );
          if (live.current) await refresh(!!result);
          return !!result;
        }}
      />}
      {feedbackArea === "routing" && feedback}
    </View>
    {configured && coordinator && <View style={section}>
      <Text accessibilityRole="header" style={heading}>{t("운영 세션 교체", "Replace coordinator")}</Text>
      <Text style={{ color: muted }}>{t("새 코디네이터를 만들 때 쓸 모델", "Model for the next coordinator")} · {loading ? t("조회 중…", "Loading\u2026") : routeName(model, t)}</Text>
      {!loading && model && <Text style={{ color: muted }}>{modeText}</Text>}
      {!loading && data && !model && <Text style={{ color: muted }}>{missingModel}</Text>}
      {confirm && <Text style={{ color }}>{t("새 운영 세션이 준비되면 담당자를 바꿉니다. 진행 중인 작업과 결정 카드는 유지됩니다.", "The new session takes over when ready. Current work and decisions stay on the board.")}</Text>}
      <View style={wrap}>
        <Button theme={theme} label={confirm ? t("교체 취소", "Cancel replacement") : t("새 코디네이터로 교체…", "Replace coordinator\u2026")}
          disabled={busy || (!confirm && (loading || !model || !mode))} onPress={() => setConfirm(!confirm)} />
        {confirm && <Button theme={theme} label={t("새 세션으로 교체", "Switch to new session")} disabled={busy || loading || !model || !mode} onPress={connect} />}
      </View>
      {feedbackArea === "coordinator" && feedback}
    </View>}
  </View>;

  return <View style={section}>
    <View style={{ ...wrap, alignItems: "center" }}>
      <Text accessibilityRole="header" style={heading}>{t("코디네이터", "Coordinator")}</Text>
      {coordinator && openCoordinator && <SessionChip theme={theme} label={t("코디네이터 세션", "Coordinator session")} accessibilityLabel={t("코디네이터 세션 열기", "Open coordinator session")} onPress={() => openCoordinator(coordinator)} />}
    </View>
    {coordinator ? <>
      <View style={{ ...wrap, alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color, fontWeight: "600" }}>{t("코디네이터에게 맡길 일", "Request for the coordinator")}</Text>
        <Button theme={theme} expanded={editorExpanded}
          label={editorExpanded ? t("입력창 접기", "Collapse editor") : t("입력창 펼치기", "Expand editor")}
          onPress={() => setEditorExpanded(expanded => !expanded)} />
      </View>
      <PhotoComposer theme={theme} disabled={busy} draft={photoDraft} text={text} showHint
        openSession={openCoordinator ? () => openCoordinator(coordinator) : undefined}>
        <SendTextInput send={sendRequest} accessibilityLabel={t("코디네이터에게 맡길 일", "Request for the coordinator")} placeholder={t("예: 초안 작성과 자료 검증을 나눠 맡겨 주세요", "Example: Assign the first draft and source checks separately.")} value={text}
          placeholderTextColor={muted} style={{ minHeight: 64, height: editorExpanded ? Math.min(480, Math.max(160, Math.round(windowHeight * 0.48))) : undefined,
            padding: 10, textAlignVertical: "top", color,
            backgroundColor: theme.colors.surface0, borderColor: inputFocused ? theme.colors.accent : muted, borderWidth: 2, borderRadius: 7 }}
          onFocus={() => setInputFocused(true)} onBlur={() => setInputFocused(false)}
          editable={!busy} multiline maxLength={24000} onChangeText={setText} />
      </PhotoComposer>
      <View style={wrap}>
        <SendButton theme={theme} label={t("코디네이터에 요청 보내기", "Send to coordinator")} send={sendRequest} selected={!sendRequest.disabled} />
        <Button theme={theme} label={t("다이제스트 요청", "Request digest")} disabled={busy || photoDraft.reading || !configured} onPress={() => void post("digest")} />
      </View>
      <Text style={{ color: muted }}>{!configured ? t("설정에서 관리할 프로젝트를 선택해 주세요.", "Choose a project to manage in Settings.") : t("작업 요청은 코디네이터에게 전달됩니다. 다이제스트는 내 결정과 추천 답장을 모읍니다. 자동 답장이 켜져 있으면 보드에서 확인한 사실 질문도 처리합니다.", "Requests go to the coordinator. A digest gathers decisions and suggested replies. When automatic replies are on, it also answers verified board questions.")}</Text>
    </> : <>
      <Text style={{ color: muted }}>{loading ? t("사용할 수 있는 모델을 확인하고 있습니다.", "Checking available models\u2026") :
        model ? t(`연결된 모델로 운영 세션을 만듭니다 · ${routeName(model, t)}`, `Create a coordinator session with ${routeName(model, t)}`) :
        data ? missingModel : t("설정에서 실행기와 모델을 새로 고쳐 주세요.", "Refresh providers and models in Settings.")}</Text>
      {!loading && model && <Text style={{ color: muted }}>{modeText}</Text>}
      <View style={wrap}><Button theme={theme} label={data?.routing.M ? t("저장한 모델로 시작", "Start with saved model") : t("추천 설정으로 시작", "Start with recommended settings")} disabled={busy || loading || !model || !mode} onPress={connect} /></View>
    </>}
    {feedback}
  </View>;
}
