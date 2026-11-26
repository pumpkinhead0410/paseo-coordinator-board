import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { reportingKey } from "../shared/contract";
import { excerpt } from "./conversation";
import type { NoteStore } from "./notes";

const reportInput = z.object({
  kind: z.enum(["question", "review"]),
  text: z.string().trim().min(1).max(2000),
});

export function recordReport(store: NoteStore, sessionId: string, report: z.infer<typeof reportInput>, evidenceId?: string) {
  const current = store.visible(new Set([sessionId]))[sessionId];
  if (current && current.kind !== "clear" && current.origin !== "agent") {
    return { isError: true, text: "A person has a record on this card. Leave your update in the session." };
  }
  const result = store.update({
    sessionId, ...report, ...(evidenceId ? { evidenceId } : {}), expectedRevision: current?.revision ?? 0,
  }, "agent");
  return result.ok ? { text: "Reported on your own Coordinator Board card." } :
    { isError: true, text: "The card changed. Leave your update in the session." };
}

export function attachReportTool(server: PluginServerContext, store: NoteStore) {
  const tool = defineAgentTool({
    name: "report_to_board",
    description: "Post a decision only the user can make (question), or a result and evidence to inspect (review), on your own session card. A report does not approve or complete the work.",
    input: reportInput,
    async execute(report, { agent, paseo }) {
      const handle = paseo.agents.ref(agent.id);
      await handle.refresh();
      if (handle.archivedAt || handle.metadata?.[reportingKey] !== true) {
        return { isError: true, text: "Board reporting is disabled for this session." };
      }
      let evidenceId: string | undefined;
      if (handle.timeline?.refetch) {
        try {
          const page = await handle.timeline.refetch({ direction: "tail", projection: "projected", limit: 48 });
          evidenceId = excerpt(page).id;
        } catch {
          // Preserve reporting even when timeline evidence cannot be read on this host.
        }
      }
      return recordReport(store, agent.id, report, evidenceId);
    },
  });
  return server.addHook("agent.open.before", async ({ request }) => {
    if (request.purpose !== "interactive" || request.metadata[reportingKey] !== true) return;
    return { ...request, tools: [...request.tools, tool] };
  });
}
