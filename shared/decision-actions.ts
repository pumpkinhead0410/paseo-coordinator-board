import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { workImages } from "./work-images";

export const decisionFields = z.object({
  question: z.string().trim().min(1).max(2000).optional(),
  recommendation: z.string().trim().min(1).max(2000).optional(),
  recommendationReason: z.string().trim().min(1).max(400).optional(),
  needsInput: z.string().trim().min(1).max(400).optional(),
  options: z.array(z.object({
    label: z.string().trim().min(1).max(160), reply: z.string().trim().min(1).max(2000),
  })).max(10).optional(),
});
export const decisionSchema = decisionFields.extend({
  question: z.string().min(1),
  questionMarkdown: z.string().max(2000).optional(),
  evidenceId: z.string().optional(),
  version: z.string().min(1).max(64),
  source: z.enum(["permission", "conversation", "coordinator", "agent-note", "person-note"]),
});
export type Decision = z.output<typeof decisionSchema>;

const id = z.string().min(1).max(256);
export const decisionRequest = z.strictObject({
    projectId: z.string().min(1).max(4096), sessionId: id, recipientId: id,
    version: z.string().min(1).max(64),
    action: z.enum(["reply", "question", "coordinate"]),
    text: z.string().max(24000),
    images: workImages.optional(),
    requestKey: z.string().min(12).max(96).regex(/^[A-Za-z0-9_-]+$/),
});
export const sendDecision = defineRpc({
  name: "board.send-decision",
  input: decisionRequest.refine(input => !!input.text.trim() || !!input.images?.length, "Provide text or a photo."),
  output: z.object({ ok: z.literal(true), recipientId: id, messageId: z.string().uuid() }),
});
export type DecisionInput = z.input<typeof sendDecision.input>;
