export const separateTaskWithdrawalPattern = /(?:별도(?:의)?\s*(?:작업|요청|안건|이슈|문서|태스크)|별개(?:의)?\s*(?:작업|요청|안건|이슈|문서|태스크)|다른\s*(?:작업|요청|안건|이슈)|무관한\s*(?:작업|요청|안건|이슈)|\b(?:separate|unrelated|other)\s+(?:task|request|work|issue)\b)/i;
const remainingNeedPattern = /(?:여전히|아직|계속)\s*(?:필요(?!\s*(?:없|하지\s*않|치\s*않))|남아(?!\s*있지\s*않)|남았|대기(?!\s*(?:없|하지\s*않|중이?\s*아니)))|(?:판단|결정|확인|승인|자료|응답|규칙|원문|입력|답변)(?:은|이|가)?\s*(?:여전히|아직)?\s*(?:필요(?!\s*(?:없|하지\s*않|치\s*않))|남아\s*있(?!지\s*않)|남았|대기\s*중(?!이?\s*아니)|미확정|받지\s*못)|(?<!\bnot\s+)(?<!\bno\s+longer\s+)\b(?:still\s+(?:need|needs|required|pending|waiting)|decision\s+(?:still\s+)?(?:needed|required|remaining)|awaiting\s+(?:user|human|input|decision|assets?))\b/i;
const stillAskingPattern = /[?？]\s*$|(?:알려\s*주세요|제공해\s*주세요|확인해\s*주세요|부탁드립니다|기다리겠습니다|기다립니다)\.?$/;

export function questionSentences(text: string): string[] {
  return text.trim().split(/(?:\r?\n|(?<=[.!?。])\s+)/).map(sentence => sentence.trim()).filter(Boolean);
}

export function remainingHumanNeeds(text: string, includeRequests = true): string[] {
  return questionSentences(text).filter(sentence => !separateTaskWithdrawalPattern.test(sentence) &&
    (remainingNeedPattern.test(sentence) || (includeRequests && stillAskingPattern.test(sentence))));
}

export const referenceIssuePattern = /(?:참고|관련|연관|이전|선행|후행|별도|별개|제외|대신|see|refs?|related(?:\s+to)?|duplicate\s+of|blocked\s+by)\s*(?:이슈|issue)?\s*(?:https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+|(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+)/gi;

const genericTopicStopwords = new Set([
  "이슈", "사람", "확인", "요청", "질문", "대기", "진행", "위해", "제공", "알려", "주세요",
  "부탁드립니다", "관련", "참고", "사용자", "철회", "취소", "남은", "결정", "없음", "필요",
  "판단", "합니다", "했습니다", "있나요", "통합", "완료", "종료", "기다립니다", "있습니다",
  "입니다", "것을", "위한", "대한", "에서", "으로", "까지", "부터", "하며", "하고", "했고",
  "issue", "user", "request", "question", "waiting", "please", "confirm", "check", "withdrawn", "cancelled", "canceled",
]);

export function extractTopicTokens(text: string): Set<string> {
  const cleaned = text
    .replace(referenceIssuePattern, " ")
    .replace(/https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/\d+\b/gi, " ")
    .replace(/(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+\b/g, " ");
  const tokens = new Set<string>();
  for (const raw of cleaned.match(/[0-9A-Za-z가-힣]+(?:-[0-9A-Za-z가-힣]+)*/g) ?? []) {
    const normalized = raw
      .toLowerCase()
      .replace(/(?:에서는|에서도|으로는|으로도|에서|에게|까지|부터|으로|은|는|이|가|을|를|의|에|로|와|과|도|만)$/, "");
    if (
      normalized.length < 2 ||
      /^\d+$/.test(normalized) ||
      genericTopicStopwords.has(normalized) ||
      /^(?:확인|철회|취소|대기|종료|완료|진행)(?:했|됐|되었|합니|됩니|입니|됨|함)/.test(normalized)
    ) continue;
    tokens.add(normalized);
  }
  return tokens;
}


export function hasRemainingHumanNeed(text: string): boolean {
  return remainingHumanNeeds(text).length > 0;
}

export function sharesQuestionTopic(sentence: string, question: string): boolean {
  const topic = extractTopicTokens(question);
  return [...extractTopicTokens(sentence)].some(token => topic.has(token));
}
