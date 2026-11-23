import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { accountUsage } from "./usage-routing";
import { workImages } from "./work-images";
export { WORK_IMAGE_MIME_TYPES, MAX_WORK_IMAGES, MAX_WORK_IMAGE_BYTES, MAX_WORK_IMAGES_BYTES, type WorkImage } from "./work-images";
import { routePreviewSchema } from "./route-decision";
import { catalogModelSchema, providerEntrySchema, workerModeProvider, gradeSchema, routeChoiceSchema, routePolicySchema } from "./dispatch";

export const operationState = defineRpc({
  name: "board.operations",
  input: z.strictObject({ view: z.literal("setup").optional() }),
  output: z.object({
    catalog: z.array(catalogModelSchema),
    providers: z.array(providerEntrySchema),
    workerModeOverrides: z.record(workerModeProvider, z.string()).optional(),
    usage: z.array(accountUsage).optional(), displayUsage: z.array(accountUsage).optional(), usageRouting: z.boolean().optional(),
    coordinatorMode: z.object({ id: z.string(), label: z.string() }).nullable(),
    routing: routePolicySchema,
    routes: routePreviewSchema,
    revision: z.number().int().nonnegative(),
  }),
});
export const setWorkerMode = defineRpc({
  name: "board.set-worker-mode",
  input: z.strictObject({ provider: workerModeProvider, modeId: z.string().min(1).max(256).nullable(),
    expectedRevision: z.number().int().nonnegative() }),
  output: z.object({ ok: z.boolean() }),
});
export const setProviderInclusion = defineRpc({
  name: "board.set-provider-inclusion",
  input: z.strictObject({
    provider: z.string().min(1).max(256), included: z.boolean(), expectedRevision: z.number().int().nonnegative(),
  }),
  output: z.object({ ok: z.boolean() }),
});
export const updateRouting = defineRpc({
  name: "board.update-routing",
  input: z.strictObject({
    grade: gradeSchema,
    candidates: z.array(routeChoiceSchema).max(12),
    expectedRevision: z.number().int().nonnegative(),
  }),
  output: z.object({ ok: z.boolean() }),
});
export const setupCoordinator = defineRpc({
  name: "board.setup-coordinator",
  input: z.strictObject({
    replace: z.boolean(),
    expectedCoordinator: z.string().nullable(),
    expectedRoute: routeChoiceSchema,
    expectedModeId: z.string().min(1).optional(),
  }),
  output: z.object({ sessionId: z.string(), workspaceId: z.string().nullable(), reused: z.boolean(), pinFailed: z.boolean().optional() }),
});
export const coordinatorPinSettings = defineRpc({
  name: "board.coordinator-pin-settings",
  input: z.strictObject({}),
  output: z.object({
    enabled: z.boolean(),
    workspace: z.object({ id: z.string(), coordinator: z.string(), title: z.string(), pinned: z.boolean() }).nullable(),
  }),
});
export const setCoordinatorAutoPin = defineRpc({
  name: "board.set-coordinator-auto-pin",
  input: z.strictObject({ enabled: z.boolean() }),
  output: z.object({ ok: z.boolean() }),
});
export const pinCurrentCoordinator = defineRpc({
  name: "board.pin-current-coordinator",
  input: z.strictObject({ coordinator: z.string().min(1), workspaceId: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
});
export type CoordinatorPinSettings = z.output<typeof coordinatorPinSettings.output>;
const messageFields = { coordinator: z.string().min(1).max(256), requestKey: z.string().min(12).max(96) };
export const askDigest = defineRpc({
  name: "board.request-digest",
  input: z.strictObject({ ...messageFields, language: z.enum(["ko", "en"]).optional(), handleBoardFacts: z.boolean().optional() }),
  output: z.object({ ok: z.boolean() }),
});
export const requestWork = defineRpc({
  name: "board.request-work",
  input: z.strictObject({
    ...messageFields,
    text: z.string().trim().max(24000),
    images: workImages.optional(),
  }).refine(({text, images}) => !!text || !!images?.length, "Provide text or a photo."),
  output: z.object({ ok: z.boolean() }),
});
export type Operations = z.output<typeof operationState.output>;
