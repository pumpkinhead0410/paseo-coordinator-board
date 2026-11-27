import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { decisionSchema } from "./decision-actions";
import { pullRequestViewSchema, repositorySlug } from "./prs";
import { trackedDecisionViewSchema } from "./tracked-decisions";
import { factSchema } from "./board-facts";

import { clarificationEntry } from "./clarifications";
import { replyEntry } from "./reply-history";
import { workspacePullSchema } from "./workspace-pull";

const sessionId = z.string().min(1).max(256);
const noteKind = z.enum(["question", "review", "done", "clear"]);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const session = z.object({
  id: sessionId,
  title: z.string(),
  projectId: z.string(),
  projectTitle: z.string(),
  projectRepo: repositorySlug.optional(),
  workspaceId: z.string().optional(),
  workspaceTitle: z.string(),
  workspacePull: workspacePullSchema.optional(),
  sourceProjectId: z.string().optional(),
  sourceProjectTitle: z.string().optional(),
  model: z.string().nullable(),
  provider: z.string().nullable().optional(),
  reporting: z.boolean().optional(),
  status: z.string().optional(),
  evidenceId: z.string().optional(),
  decision: decisionSchema.optional(),
  decisionAnswered: z.boolean().optional(),
  agentNoteSuperseded: z.boolean().optional(),
  boardFact: factSchema.extend({ current: z.boolean() }).optional(),
  hasActiveTurn: z.literal(true).optional(),
  nativePending: z.boolean().optional(),
  permissionVersion: z.string().optional(),
  decisionRequestedAt: z.string().optional(),
  activityAt: z.string().optional(),
  lane: z.enum(["human", "running", "review", "idle", "unknown"]),
  detail: z.string(),
});
export const noteSchema = z.object({
  sessionId,
  kind: noteKind,
  evidenceId: z.string().max(64).optional(),
  questionCursor: z.string().max(64).optional(),
  origin: z.enum(["person", "agent"]).optional(),
  requestedAt: z.string().optional(),
  text: z.string().max(2000),
  revision,
});
export type Note = z.infer<typeof noteSchema>;
export type SessionRow = z.infer<typeof session>;

export const boardScope = defineRpc({
  name: "board.scope", input: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("project"), projectId: z.string().min(1), enabled: z.boolean() }),
    z.object({ kind: z.literal("coordinator"), sessionId: sessionId.nullable() }),
  ]), output: z.object({ ok: z.boolean() }),
});

export const boardSnapshot = defineRpc({
  name: "board.snapshot",
  input: z.object({ fresh: z.boolean().optional() }),
  output: z.object({ sessions: z.array(session), notes: z.record(z.string(), noteSchema),
    projects: z.array(z.object({ id: z.string(), title: z.string(), path: z.string(), selected: z.boolean() })),
    coordinator: sessionId.nullable(), clarifications:z.array(clarificationEntry).optional(), replyHistory: z.array(replyEntry).optional(), trackedDecisions: trackedDecisionViewSchema.optional(), pullRequests: pullRequestViewSchema.optional() }),
});
export const claimBoardQuotaNotice = defineRpc({
  name: "board.claim-quota-notice", input: z.strictObject({}),
  output: z.object({ message: z.string().nullable() }),
});
export const boardDecisionCount = defineRpc({
  name: "board.decision-count", input: z.strictObject({}),
  output: z.object({ count: z.number().int().nonnegative() }),
});
export const saveNote = defineRpc({
  name: "board.save-note",
  input: z.object({
    sessionId,
    kind: noteKind,
    text: z.string().trim().max(2000),
    expectedRevision: revision,
    evidenceId: z.string().max(64).optional(),
  }).refine(input => input.kind === "clear" || input.text.length > 0, {
    message: "질문, 확인할 일 또는 완료 근거를 입력해 주세요.",
  }),
  output: z.object({ ok: z.boolean(), conflict: z.boolean() }),
});

export const reportingKey = "coordinator-board/reports";
export const setReporting = defineRpc({
  name: "board.set-reporting",
  input: z.object({ sessionId, enabled: z.boolean() }),
  output: z.object({ ok: z.boolean() }),
});
