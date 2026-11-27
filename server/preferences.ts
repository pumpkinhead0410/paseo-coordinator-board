import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { sessionLinkSchema } from "../shared/session-links";
import {clarificationCard, clarificationEntry} from "../shared/clarifications";
import { decisionSchema, decisionFields } from "../shared/decision-actions";
import { routePolicySchema, workerModeProvider } from "../shared/dispatch";
import { pullMergeActivity, repositoryOverride, repositorySlug } from "../shared/prs";
import { replyDetails } from "../shared/reply-history";
import { factSchema } from "../shared/board-facts";

const commitHash = z.string().trim().regex(/^[0-9a-f]{7,40}$/i);
const completedReceiptSchema = z.object({
  kind: z.literal("completed"),
  repo: repositorySlug,
  issue: z.number().int().positive().max(2147483647),
  commit: commitHash,
  verifiedCommit: commitHash,
  verification: z.object({
    source: z.enum(["ci", "local"]),
    status: z.literal("passed"),
    summary: z.string().trim().min(1).max(300),
  }),
  closeReason: z.literal("COMPLETED"),
  cleanupHandoff: z.string().trim().min(1).max(300).optional(),
});
const notPlannedReceiptSchema = z.object({
  kind: z.literal("not_planned"),
  repo: repositorySlug,
  issue: z.number().int().positive().max(2147483647),
  closeReason: z.literal("NOT_PLANNED"),
  stopReason: z.string().trim().min(1).max(300),
  cleanupHandoff: z.string().trim().min(1).max(300).optional(),
});
export const completionReceipt = z.discriminatedUnion("kind", [
  completedReceiptSchema,
  notPlannedReceiptSchema,
  z.object({
    kind: z.literal("withdrawn"),
    targetEvidenceId: z.string().min(1).max(64),
    targetNoteRevision: z.number().int().nonnegative().optional(),
    reason: z.string().trim().min(1).max(300),
  }),
]);
const storedCompletionReceipt = z.discriminatedUnion("kind", [
  completedReceiptSchema,
  notPlannedReceiptSchema,
  z.object({
    kind: z.literal("withdrawn"),
    targetEvidenceId: z.string().min(1).max(64).optional(),
    targetNoteRevision: z.number().int().nonnegative().optional(),
    reason: z.string().trim().min(1).max(300),
  }),
]);
export type CompletionReceipt = z.infer<typeof completionReceipt>;

export const judgment = z.object({
  content: decisionFields.optional(),
  receipt: completionReceipt.optional(),
  evidenceId: z.string(), kind: z.enum(["question", "review", "idle"]), text: z.string().trim().min(1).max(1200),
});
const storedJudgment = z.object({
  content: decisionFields.optional(),
  receipt: storedCompletionReceipt.optional(),
  evidenceId: z.string(), kind: z.enum(["question", "review", "idle"]), text: z.string().trim().min(1).max(1200),
});
const coordinatorConfig = z.object({ provider: z.string(), thinkingOptionId: z.string().optional(), modeId: z.string().optional() });
const schema = z.object({
  projects: z.array(z.string()), coordinator: z.string().nullable(),
  workerModeOverrides: z.record(workerModeProvider, z.string().min(1).max(256)).default({}),
  pullMergeHistory: z.record(z.string(), pullMergeActivity.extend({
    notificationCoordinator: z.string().nullable().optional(),
  })).default({}),
  projectRepositories: z.record(z.string(), repositoryOverride).default({}),
  autoPinCoordinatorWorkspace: z.boolean().default(true),
  autoReplyToBoardFacts: z.boolean().default(true),
  factHistory: z.record(z.string(), factSchema).default({}),
  workRequestIds: z.record(z.string(), z.string().uuid()).default({}),
  factCycleKeys: z.record(z.string(), z.literal(true)).default({}),
  factCycle: z.object({
    id: z.string(), coordinator: z.string(), expires: z.number(), messageId: z.string().optional(),
    candidates: z.record(z.string(), z.string()),
  }).optional(),
  judgments: z.record(z.string(), storedJudgment.extend({
    projectId: z.string(),
    requestedAt: z.string().optional(),
  })),
  supersededAgentNotes: z.record(z.string(), z.object({
    projectId: z.string(),
    revision: z.number().int().nonnegative(),
    evidenceId: z.string().min(1).max(64),
  })).default({}),
  sessionLinks: z.record(z.string(), sessionLinkSchema).default({}),
  routing: routePolicySchema.default({}),
  excludedProviders: z.array(z.string().min(1).max(256)).default([]),
  usageRouting: z.boolean().default(true),
  routingRevision: z.number().int().nonnegative().default(0),
  answers: z.record(z.string(), z.object({ version: z.string(), noteRevision: z.number().optional() })).default({}),
  clarifications:z.record(z.string(),clarificationEntry.extend({
    card:clarificationCard,fingerprint:z.string(),bodyHash:z.string(),sourceSessionId:z.string().nullable(),
    savedDecision:decisionSchema.optional(),noteRevision:z.number().optional(),sourceEvidenceId:z.string().optional(), sourceRequestedAt:z.string().optional(),
  })).default({}),
  decisionReceipts: z.record(z.string(), z.object({
    activity: replyDetails.optional(), response: z.string().optional(),
    messageHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
    fingerprint: z.string(), sessionId: z.string(), version: z.string(), status: z.enum(["pending", "sent"]),
    evidenceId: z.string().optional(),
    noteRevision: z.number().optional(), beforeAnswer: z.string().optional(), messageId: z.string().optional(),
  })).default({}),
  pendingCoordinator: z.object({
    id: z.string(), previous: z.string().nullable(),
    config: coordinatorConfig,
  }).optional(),
  createdCoordinator: z.object({
    id: z.string(), previous: z.string().nullable(), workspaceId: z.string(), config: coordinatorConfig,
  }).optional(),
});
export type Preferences = z.infer<typeof schema>;

export function isManagedCoordinator(scope: Preferences, id: string | null) {
  return id !== null && scope.createdCoordinator?.id === id;
}

export function setCoordinator(scope: Preferences, id: string | null) {
  if (scope.coordinator !== id) delete scope.factCycle;
  scope.coordinator = id;
  // A person's new selection supersedes any creation still in progress.
  delete scope.pendingCoordinator;
  // Judgments belong to the observed project/session and evidence, not the writer.
}

export class PreferenceStore {
  constructor(private readonly path: string) {}
  get directory() { return dirname(this.path); }
  read(): Preferences {
    try { return schema.parse(JSON.parse(readFileSync(this.path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return schema.parse({ projects: [], coordinator: null, judgments: {} });
      throw error;
    }
  }
  change(edit: (value: Preferences) => void) {
    const value = this.read();
    edit(value);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = this.path + "." + randomUUID();
    try {
      writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      renameSync(temp, this.path);
    } finally { rmSync(temp, { force: true }); }
  }
}
