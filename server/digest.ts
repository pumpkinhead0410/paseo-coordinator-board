import { canReceiveBoardInput } from "./discovery";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { createHash } from "node:crypto";
import { photoDigest } from "./reply-photos";
import { PreferenceStore } from "./preferences";
import type { WorkImage } from "../shared/operations";

const prompts = {
  ko: "관리 프로젝트의 다이제스트를 한국어로 갱신하세요. review_board_records로 완료된 단독 병합 기록을 정리하세요. 다른 확인 기록은 원 세션에서 완료 근거가 확인된 경우에만 이 도구로 닫으세요. read_board_conversation에서 최근 근거와 기존 판단(judgment)·카드 기록(note)을 확인하고 classify_board_conversation으로 기록하세요. 구현 통합 건은 최신 통합 커밋·검증 영수증·GitHub COMPLETED 종료를 확인한 경우에만 완료로 판정하고, 조사 중단 건은 통합 커밋 없이 중단 사유와 GitHub NOT_PLANNED 종료 근거를 확인해 해결 완료와 구분해 기록하세요. 완료 영수증이나 종료 근거가 없으면 완료·종결로 판정하지 마세요. 제품 통합 결과와 workspace 정리 인계는 구분하고, 실행 중 사유로 분류가 거절된 세션은 대기 전환 뒤 최신 evidenceId로 다시 분류해 이전 검증 대기가 남지 않게 하세요. 각 질문에는 당사자가 정할 한 문장을 content.question에 적으세요. 근거·기존 기준에서 제안할 수 있는 가장 타당한 답장 하나를 content.recommendation에, 간단한 이유를 content.recommendationReason에 적으세요. 증거에 실제 답장 문장이 없어도 근거 있는 제안은 작성할 수 있습니다. 판단에 필요한 정보가 부족하면 결정을 지어내지 말고 필요한 정보를 content.needsInput에 적으세요. 예전에 판단한 질문도 needsRecommendation이 표시되면 갱신하세요. 진행 보고와 이미 정해진 사항은 내 결정에서 내리고, 직접 결정할 안건을 먼저 보고하세요.",
  en: "Refresh the digest for managed projects in English. Use review_board_records for verified standalone merges and coordinator checks with completion evidence from the originating session. Inspect recent evidence along with existing board judgments and card notes via read_board_conversation and record updates with classify_board_conversation. Mark integrated implementation work complete only when the integration commit, validation receipt, and GitHub COMPLETED closure are confirmed; for investigation stops closed as NOT_PLANNED, verify the stop reason and NOT_PLANNED closure without requiring an integration commit and keep them distinct from resolved fixes. Never assume completion or closure without receipts or closure evidence. Separate product integration results from workspace cleanup handoffs, and if classification is rejected while a session is running, reread the latest evidenceId once it returns to idle so stale pre-integration waits do not linger. For every genuine human decision, write one short question in content.question. When evidence or an established preference supports it, propose one editable, ready-to-send reply in content.recommendation and give a brief reason in content.recommendationReason. The proposed wording may be new. If essential input is missing, name it in content.needsInput without inventing the person's choice. Revisit earlier decisions marked needsRecommendation. Keep progress reports and resolved matters out of My decisions, and report the remaining decisions first.",
};

export const digestPrompt = prompts.ko + " 이번 요청은 조회와 분류만 맡깁니다.";
export const englishDigestPrompt = prompts.en + " Limit this request to reading and classification.";

export function digestWithFactReplies(language: "ko" | "en", cycleId: string) {
  const instructions = language === "ko"
    ? "이번 다이제스트에서 보드가 단독 사실 질문으로 식별한 세션에는 answer_board_fact로 답하세요. 이 도구가 허용한 대상·근거에 대해서만 코디네이터 이름으로 확인된 사실을 보낼 수 있습니다. 다른 방식의 메시지 전송은 요청하지 않았습니다. 처리 결과와 사람이 결정할 안건을 구분하세요."
    : "For this digest, call answer_board_fact for standalone factual questions identified by the board. Only that tool may send its verified facts as the coordinator. Do not send a message by any other route. Report handled items separately from human decisions.";
  return prompts[language] + " " + instructions + " " + JSON.stringify({ cycleId });
}

export async function sendCoordinatorRequest(
  paseo: PluginHandlerContext["paseo"],
  store: PreferenceStore,
  expected: string,
  key: string,
  text: string,
  options: {
    images?: WorkImage[];
    reserveMessage?: (originalId: string) => string;
    allowActiveCoordinator?: boolean;
    beforeSend?: (messageId: string) => void;
  } = {},
) {
  if (store.read().coordinator !== expected) throw new Error("현재 코디네이터를 다시 확인해 주세요.");
  if (!store.read().projects.length) throw new Error("관리할 프로젝트를 하나 이상 선택하세요.");
  const handle = paseo.agents.ref(expected);
  const snapshot = (await handle.refresh())?.agent;
  if (
    !snapshot ||
    snapshot.archivedAt ||
    snapshot.internal ||
    !canReceiveBoardInput(snapshot,options.allowActiveCoordinator===true)
  ) {
    throw new Error("코디네이터가 대기 상태일 때 요청할 수 있습니다. 세션에서 현재 작업을 확인하세요.");
  }
  if (store.read().coordinator !== expected) throw new Error("코디네이터가 교체되었습니다. 새로 고쳐 주세요.");
  if (!store.read().projects.length) throw new Error("관리 프로젝트가 변경되었습니다.");
  const images = options.images;
  const content = images?.length ? [expected, key, text, images.map(photoDigest)] : [expected, key, text];
  const id = createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex");
  const originalId = [
    id.slice(0, 8),
    id.slice(8, 12),
    "4" + id.slice(13, 16),
    "8" + id.slice(17, 20),
    id.slice(20, 32),
  ].join("-");
  const messageId = options.reserveMessage?.(originalId) ?? originalId;
  options.beforeSend?.(messageId);
  await handle.send(text, { messageId, activeTurnBehavior: "steer", ...(images?.length ? {images} : {}) });
  return { ok: true };
}
