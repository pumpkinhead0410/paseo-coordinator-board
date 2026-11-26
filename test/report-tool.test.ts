import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoteStore } from "../server/notes";
import { attachReportTool } from "../server/reporting";
import { reportingKey } from "../shared/contract";

test("only opted-in interactive sessions get the reporting tool, and revocation takes effect immediately", async () => {
  const root = mkdtempSync(join(tmpdir(), "coordinator-hook-"));
  try {
    const store = new NoteStore(join(root, "notes.json"));
    let open;
    attachReportTool({ addHook: (_event, hook) => { open = hook; return () => {}; } }, store);
    const request = { purpose: "interactive", metadata: {}, tools: [{ name: "existing" }] };
    expect(await open({ request })).toBeUndefined();
    const selected = { ...request, metadata: { [reportingKey]: true } };
    expect(await open({ request: { ...selected, purpose: "history" } })).toBeUndefined();
    const opened = await open({ request: selected });
    expect(opened.tools.map(t => t.name)).toEqual(["existing", "report_to_board"]);
    let enabled = true;
    const ctx = {
      agent: { id: "mine" },
      paseo: { agents: { ref: id => {
        expect(id).toBe("mine");
        return { refresh: async () => {}, metadata: { [reportingKey]: enabled }, archivedAt: null };
      } } },
    };
    const tool = opened.tools[1];
    const report = { kind:"review", text:"Test receipt" };
    expect(tool.input.safeParse({...report,kind:"done"}).success).toBe(false);
    await tool.execute(report,ctx);
    expect(store.visible(new Set(["mine"])).mine.origin).toBe("agent");
    enabled = false;
    expect((await tool.execute({...report,text:"second"},ctx)).isError).toBe(true);
    expect(store.visible(new Set(["mine"])).mine.text).toBe(report.text);
  } finally { rmSync(root, {recursive:true,force:true}); }
});

test("report_to_board stores the current timeline evidenceId on agent notes when timeline is readable", async () => {
  const root = mkdtempSync(join(tmpdir(), "coordinator-hook-ev-"));
  try {
    const store = new NoteStore(join(root, "notes.json"));
    let open: any;
    attachReportTool({ addHook: (_event: string, hook: any) => { open = hook; return () => {}; } } as any, store);
    const opened = await open({ request: { purpose: "interactive", metadata: { [reportingKey]: true }, tools: [] } });
    const tool = opened.tools[0];
    const entries = [{ seqEnd: 1, item: { type: "assistant_message", text: "#308 H1 확인을 부탁드립니다." } }];
    const ctx = {
      agent: { id: "w308" },
      paseo: {
        agents: {
          ref: () => ({
            refresh: async () => {},
            metadata: { [reportingKey]: true },
            archivedAt: null,
            timeline: { refetch: async () => ({ epoch: "1", entries }) },
          }),
        },
      },
    };
    const res = await tool.execute({ kind: "question", text: "#308 사람 확인 H1" }, ctx);
    expect(res.isError).not.toBe(true);
    const saved = store.visible(new Set(["w308"])).w308;
    expect(saved.origin).toBe("agent");
    expect(saved.evidenceId).toMatch(/^[a-f0-9]{24}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("report_to_board rechecks reporting status and archive state after reading timeline", async () => {
  const root = mkdtempSync(join(tmpdir(), "coordinator-hook-toctou-"));
  try {
    const store = new NoteStore(join(root, "notes.json"));
    let open: any;
    attachReportTool({ addHook: (_event: string, hook: any) => { open = hook; return () => {}; } } as any, store);
    const opened = await open({ request: { purpose: "interactive", metadata: { [reportingKey]: true }, tools: [] } });
    const tool = opened.tools[0];

    for (const mutate of [
      (state: { enabled: boolean; archivedAt: string | null }) => { state.enabled = false; },
      (state: { enabled: boolean; archivedAt: string | null }) => { state.archivedAt = "2026-11-27T00:00:00Z"; },
    ]) {
      const state = { enabled: true, archivedAt: null as string | null };
      const handle = {
        metadata: { [reportingKey]: true },
        archivedAt: null as string | null,
        refresh: async () => {
          handle.metadata = { [reportingKey]: state.enabled };
          handle.archivedAt = state.archivedAt;
        },
        timeline: {
          refetch: async () => {
            mutate(state);
            return { epoch: "1", entries: [{ seqEnd: 1, item: { type: "assistant_message", text: "질문" } }] };
          },
        },
      };
      const res = await tool.execute(
        { kind: "question", text: "비활성화 중 보고" },
        { agent: { id: "revoked" }, paseo: { agents: { ref: () => handle } } },
      );
      expect(res.isError).toBe(true);
      expect(store.visible(new Set(["revoked"])).revoked).toBeUndefined();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
