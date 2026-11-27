import type { DecisionInput } from "../shared/decision-actions";
import type { SessionRow } from "../shared/contract";
import type { TrackedDecisionInput, TrackedResolution } from "../shared/tracked-decisions";

type ReplyContext = {
  projectId: string | null;
  projectTitle: string | null;
  source: string;
  sourceSessionId: string | null;
  sourceSessionTitle?: string;
  sourceHost?: string | null;
  recipientSessionId: string;
  cardId: string;
  cardTitle: string;
  revision: string;
  evidenceId?: string;
  recordedAt?: string;
  questions: {id:string; text:string; index?:number}[];
  action: string;
};

// The context is board-generated. Keep it separate from the user's verbatim input.
function message(context: ReplyContext, answer: string) {
  const heading = [context.projectTitle, context.cardTitle].filter(Boolean).join(" · ").replace(/\s+/g," ").slice(0,180);
  return "[Coordinator Board · " + heading + "]\n" + JSON.stringify(context) + "\n\n" + answer;
}

function trackedQuestions(item:TrackedDecisionInput,input:TrackedResolution) {
  const selected = input.questionIndexes ?? item.questions.map((_,i) => i);
  return item.questions.length ? selected.map(i => ({
    id: item.questions[i].id || "question-" + (i + 1), index:i, text: item.questions[i].text,
  })) : [{id: item.id, text: item.ask[0] || item.title}];
}

export function trackedReplyOrigin(item:TrackedDecisionInput, input:TrackedResolution) {
  return {sessionId:item.sessionId ?? item.sessionMatch?.sessionId ?? null, sessionHost:item.sessionHost ?? undefined,
    ...(item.sessionMatch && (!item.sessionId || item.sessionMatch.sessionId === item.sessionId) ? {sessionProjectId:item.sessionMatch.projectId} : {}),
    cardId:item.id, revision:input.fingerprint,
    questions:trackedQuestions(item,input).map(({text,...ref})=>ref)};
}

export function trackedReplyMessage(item: TrackedDecisionInput, input: TrackedResolution) {
  return message({
    projectId:item.projectId, projectTitle:item.projectTitle ?? null, source:item.source,
    sourceSessionId:item.sessionId ?? item.sessionMatch?.sessionId ?? null, sourceHost:item.sessionHost ?? null,
    recipientSessionId:input.recipientId!, cardId:item.id, cardTitle:item.title, revision:input.fingerprint,
    recordedAt:item.since ?? undefined, questions:trackedQuestions(item,input), action:"reply",
  }, input.answer ?? "");
}

export function sessionReplyMessage(row:SessionRow, input:DecisionInput) {
  const decision = row.decision!;
  return message({
    projectId:row.projectId, projectTitle:row.projectTitle, source:decision.source,
    sourceSessionId:row.id, sourceSessionTitle:row.title, recipientSessionId:input.recipientId,
    cardId:row.id, cardTitle:row.title, revision:decision.version, evidenceId:decision.evidenceId ?? row.evidenceId,
    questions:[{id:decision.version, text:decision.question}], action:input.action,
  }, input.text);
}
