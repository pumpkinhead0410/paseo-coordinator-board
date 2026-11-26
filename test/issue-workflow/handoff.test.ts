import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachCoordinatorTools } from "../../server/coordinator";
import { restoreClarifiedDecision } from "../../server/clarifications";
import { classify, ConversationReader, excerpt } from "../../server/conversation";
import { decorateDecision, isSupersededAgentNote } from "../../server/decisions";
import { digestPrompt, englishDigestPrompt } from "../../server/digest";
import { buildCoordinatorSystemPrompt } from "../../server/lifecycle";
import { NoteStore } from "../../server/notes";
import { createOperations } from "../../server/operations";
import { PreferenceStore } from "../../server/preferences";
import { recordReport } from "../../server/reporting";
import { sessionClarificationCard } from "../../shared/clarifications";
import type { Note, SessionRow } from "../../shared/contract";
import { decisionCount, displayLane } from "../../shared/decision-count";
import { legacyRouter } from "../legacy-router";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type MockAgent = {
  id: string;
  title: string;
  workspaceId: string;
  status: string;
  updatedAt: string;
  pendingPermissions: { id: string }[];
};

async function openIssueBoard() {
  const dir = mkdtempSync(join(tmpdir(), "board-issue-workflow-"));
  dirs.push(dir);
  const prefs = new PreferenceStore(join(dir, "scope.json"));
  const notes = new NoteStore(join(dir, "notes.json"));
  prefs.change(scope => { scope.projects = ["easydocs"]; scope.coordinator = "coord"; });

  const workspaces = [
    {
      id: "wks_main",
      projectId: "easydocs",
      title: "EasyDocs · main",
      name: "EasyDocs",
      workspaceKind: "local_checkout" as const,
      workspaceDirectory: "/synthetic/EasyDocs",
      gitRuntime: { currentBranch: "main" },
    },
    {
      id: "wks_308",
      projectId: "easydocs",
      title: "EasyDocs #308 · 2열 사진 교체 구현",
      name: "easydocs-308",
      workspaceKind: "worktree" as const,
      workspaceDirectory: "/synthetic/worktrees/easydocs-308",
      gitRuntime: { currentBranch: "feat/two-col-photo-replace-308" },
    },
  ];

  const agents: MockAgent[] = [
    { id: "coord", title: "코디네이터", workspaceId: "wks_main", status: "idle", updatedAt: "2026-11-26T05:50:00Z", pendingPermissions: [] },
    { id: "w308", title: "#308 2열 사진 교체 · 구현", workspaceId: "wks_308", status: "idle", updatedAt: "2026-11-26T05:50:00Z", pendingPermissions: [] },
    { id: "w303", title: "#303 보관 PR runner 시험 근거", workspaceId: "wks_main", status: "idle", updatedAt: "2026-11-26T05:44:34Z", pendingPermissions: [] },
    { id: "w305", title: "[인계] #305 CE/UL 안전문·저작권 2단계", workspaceId: "wks_main", status: "idle", updatedAt: "2026-11-26T06:20:00Z", pendingPermissions: [] },
  ];

  const timelines = new Map<string, string[]>([
    ["w308", ["#308 사진 교체 버튼 H1 확인을 e9fe346에 기록했습니다. 운영 세션의 실제 통합 결과 최종검증이 남았습니다."]],
    ["w303", ["#303 라이선스 검사 일정 미정으로 조사를 중단했고 GitHub에서 NOT_PLANNED로 닫힌 것을 확인했습니다."]],
    ["w305", ["#305 1단계 통합 완료. 2단계 AC-6 진행을 위해 공식 CE/UL 안전문 원문, 표지 이미지, 회사 저작권 치환 규칙을 알려 주세요."]],
  ]);

  const page = <T,>(entries: T[]) => ({ entries, pageInfo: { hasMore: false, nextCursor: null } });
  const sdk = {
    projects: {
      list: async () => ({
        projects: [{ projectId: "easydocs", projectDisplayName: "EasyDocs", projectRootPath: "/synthetic/EasyDocs" }],
      }),
    },
    workspaces: {
      list: async () => page(workspaces),
      ref: (id: string) => ({ refresh: async () => workspaces.find(w => w.id === id) ?? null }),
    },
    agents: {
      list: async () => page(agents.map(agent => ({ agent, project: { projectKey: "easydocs", projectName: "EasyDocs" } }))),
      ref: (id: string) => ({
        timeline: {
          refetch: async () => ({
            epoch: "1",
            entries: (timelines.get(id) ?? []).map((text, index) => ({
              seqEnd: index + 1,
              timestamp: agents.find(a => a.id === id)?.updatedAt,
              item: { type: "assistant_message", text },
            })),
          }),
        },
      }),
    },
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "codex", available: true }] }),
      listModes: async () => ({ modes: [{ id: "auto-review", label: "Auto-review" }] }),
      listModels: async () => ({
        models: [{ id: "gpt-6.2-sol", label: "Sol", isDefault: true, thinkingOptions: [{ id: "high" }] }],
      }),
    },
  };

  const ops = createOperations(prefs, dir, undefined, legacyRouter());
  let onOpen: ((input: { request: { purpose: string; agentId: string; tools: unknown[] } }) => Promise<{ tools: any[] }>) | undefined;
  attachCoordinatorTools(
    { addHook(_event: string, hook: any) { onOpen = hook; return () => {}; } } as any,
    prefs,
    new ConversationReader(),
    ops.tools,
    notes,
  );
  const opened = await onOpen!({ request: { purpose: "interactive", agentId: "coord", tools: [] } });
  const tool = (name: string) => opened.tools.find((t: { name: string }) => t.name === name);
  const run = async (name: string, input: Record<string, unknown> = {}) => {
    const t = tool(name);
    const result = await t.execute(t.input.parse(input), { paseo: sdk, agent: { id: "coord" } });
    return result.text;
  };
  return { prefs, notes, agents, timelines, tool, run };
}

test("plan_board_assignment exposes workspace kind, branch, path and session workspaceId for direct worktree assignment and owner reuse", async () => {
  const { run } = await openIssueBoard();
  const plan = JSON.parse(await run("plan_board_assignment"));

  expect(plan.workspaces).toEqual([
    { id: "wks_main", projectId: "easydocs", title: "EasyDocs · main", kind: "local_checkout", branch: "main", path: "/synthetic/EasyDocs" },
    { id: "wks_308", projectId: "easydocs", title: "EasyDocs #308 · 2열 사진 교체 구현", kind: "worktree", branch: "feat/two-col-photo-replace-308", path: "/synthetic/worktrees/easydocs-308" },
  ]);
  expect(plan.sessions.find((s: { id: string }) => s.id === "w308")).toMatchObject({
    id: "w308",
    workspaceId: "wks_308",
    workspaceTitle: "EasyDocs #308 · 2열 사진 교체 구현",
    status: "idle",
  });
  expect(plan.sessions.find((s: { id: string }) => s.id === "w303")).toMatchObject({
    id: "w303",
    workspaceId: "wks_main",
  });
});

test("#308 reproduction: running session rejects stale classification with actionable error, then fresh evidenceId clears pre-integration wait", async () => {
  const { prefs, notes, agents, timelines, run } = await openIssueBoard();
  const w308 = agents.find(a => a.id === "w308")!;

  // 1. Pre-integration state: worker reported H1 review note (bound to initial evidenceId) and coordinator classified review wait.
  const initialExcerpt = JSON.parse(await run("read_board_conversation", { sessionId: "w308" }));
  expect(recordReport(notes, "w308", { kind: "review", text: "#308 사람 확인 H1" }, initialExcerpt.evidenceId).isError).not.toBe(true);
  await run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: initialExcerpt.evidenceId,
    kind: "review",
    text: "#308 사진 교체 버튼 H1 확인을 e9fe346에 기록했습니다. 운영 세션의 실제 통합 결과 최종검증이 남았습니다.",
  });

  // Listing surfaces workspaceId, stale review judgment, and active agent note with its evidenceId.
  const listed = JSON.parse(await run("read_board_conversation"));
  expect(listed.find((r: { id: string }) => r.id === "w308")).toMatchObject({
    workspaceId: "wks_308",
    workspaceTitle: "EasyDocs #308 · 2열 사진 교체 구현",
    judgment: { kind: "review", evidenceId: initialExcerpt.evidenceId },
    note: { kind: "review", origin: "agent", evidenceId: initialExcerpt.evidenceId },
  });

  // Fail-closed: cannot clear verification wait to idle without completion/verification receipt.
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: initialExcerpt.evidenceId,
    kind: "idle",
    text: "#308 완료",
  })).rejects.toThrow(/완료 영수증·검증 근거/);
  expect(prefs.read().judgments.w308.kind).toBe("review");

  // Even on a fresh turn that says "통합 예정, 최종 검증 미실행", idle classification is rejected.
  w308.updatedAt = "2026-11-26T05:55:00Z";
  timelines.get("w308")!.push("통합 예정, 최종 검증 미실행");
  const unverifiedExcerpt = JSON.parse(await run("read_board_conversation", { sessionId: "w308" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: unverifiedExcerpt.evidenceId,
    kind: "idle",
    text: "#308 완료",
  })).rejects.toThrow(/완료 영수증·검증 근거/);
  expect(prefs.read().judgments.w308.kind).toBe("review");

  // A feature/work-branch commit alone (without main integration, verification pass, and closure) is also rejected.
  w308.updatedAt = "2026-11-26T05:56:00Z";
  timelines.get("w308")!.push("작업 브랜치에 cf6f661 커밋을 올렸습니다. 확인해 주세요.");
  const branchOnlyExcerpt = JSON.parse(await run("read_board_conversation", { sessionId: "w308" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: branchOnlyExcerpt.evidenceId,
    kind: "idle",
    text: "#308 cf6f661 통합 완료",
  })).rejects.toThrow(/완료 영수증·검증 근거/);
  expect(prefs.read().judgments.w308.kind).toBe("review");

  // 2. Integration finishes while w308 is running /done -> fail-closed with actionable running message.
  w308.status = "running";
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: initialExcerpt.evidenceId,
    kind: "idle",
    text: "#308 cf6f661 통합 완료",
  })).rejects.toThrow(/실행 중인 세션.*idle.*최신 evidenceId/);
  expect(prefs.read().judgments.w308.kind).toBe("review");

  // Permission wait is also distinguished from missing/closed sessions.
  w308.status = "idle";
  w308.pendingPermissions = [{ id: "perm-1" }];
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: initialExcerpt.evidenceId,
    kind: "idle",
    text: "#308 cf6f661 통합 완료",
  })).rejects.toThrow(/권한 응답 대기/);
  w308.pendingPermissions = [];

  // 3. Worker finishes /done with integration receipt + separate cleanup hold (보류 must NOT block verified integration!).
  w308.updatedAt = "2026-11-26T06:37:05Z";
  timelines.get("w308")!.push(
    "#308 마무리 점검과 정리 인계를 완료했습니다. cf6f661 원격 main 반영·D155 최종검증 통과·GitHub COMPLETED 확인. 작업 폴더 정리는 14일 보호 기준으로 보류합니다.",
  );

  // Reusing the pre-integration evidenceId is rejected.
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: initialExcerpt.evidenceId,
    kind: "idle",
    text: "#308 cf6f661 통합 완료",
  })).rejects.toThrow(/대화가 바뀌었습니다/);

  // Re-reading latest evidenceId succeeds, replaces stale review judgment, and marks the prior agent-note superseded in listing too.
  const latestExcerpt = JSON.parse(await run("read_board_conversation", { sessionId: "w308" }));
  expect(latestExcerpt.evidenceId).not.toBe(initialExcerpt.evidenceId);
  await run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: latestExcerpt.evidenceId,
    kind: "idle",
    text: "#308 cf6f661 원격 main 통합·최종검증·GitHub COMPLETED 확인. workspace 정리 인계(14일 보호 기준 보류)는 별도 추적.",
  });

  const updated = JSON.parse(await run("read_board_conversation"));
  const row308 = updated.find((r: { id: string }) => r.id === "w308");
  expect(row308.judgment).toEqual({
    kind: "idle",
    evidenceId: latestExcerpt.evidenceId,
  });
  expect(row308.note).toBeUndefined();
});

test("#303 NOT_PLANNED (confirmed vs OPEN proposal) and #305 staged human decision (including withdrawal) are handled cleanly", async () => {
  const { prefs, agents, timelines, run } = await openIssueBoard();

  const e303 = JSON.parse(await run("read_board_conversation", { sessionId: "w303" }));
  // Mislabeling a NOT_PLANNED stop as a resolved fix without mentioning NOT_PLANNED/중단 is rejected.
  await expect(run("classify_board_conversation", {
    sessionId: "w303",
    evidenceId: e303.evidenceId,
    kind: "idle",
    text: "#303 원인 해결 완료",
  })).rejects.toThrow(/NOT_PLANNED/);

  // Accurate NOT_PLANNED classification succeeds without requiring an integration commit.
  await run("classify_board_conversation", {
    sessionId: "w303",
    evidenceId: e303.evidenceId,
    kind: "idle",
    text: "#303 라이선스 우선순위 미정으로 조사 중단 · GitHub NOT_PLANNED 종료(해결 완료 아님, 공유 main 보존).",
  });

  // An OPEN issue merely proposing NOT_PLANNED closure is rejected fail-closed!
  const w303 = agents.find(a => a.id === "w303")!;
  w303.updatedAt = "2026-11-26T05:50:00Z";
  timelines.get("w303")!.push("이슈 #303은 현재 OPEN 상태이며 NOT_PLANNED 종료를 제안합니다.");
  const openProposal = JSON.parse(await run("read_board_conversation", { sessionId: "w303" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w303",
    evidenceId: openProposal.evidenceId,
    kind: "idle",
    text: "#303 NOT_PLANNED 종료",
  })).rejects.toThrow(/NOT_PLANNED/);

  const e305 = JSON.parse(await run("read_board_conversation", { sessionId: "w305" }));
  await run("classify_board_conversation", {
    sessionId: "w305",
    evidenceId: e305.evidenceId,
    kind: "question",
    text: "#305 2단계 공식 자료·저작권 규칙 대기",
    content: {
      question: "#305 2단계(1단계 통합 완료) 진행을 위해 공식 CE/UL 안전문 원문, 표지 이미지, 저작권 치환 규칙을 제공해 주실 수 있나요?",
      needsInput: "공식 CE/UL 안전문 원문·표지 이미지·회사 저작권 치환 규칙",
    },
  });

  expect(prefs.read().judgments.w303).toMatchObject({ kind: "idle" });
  expect(prefs.read().judgments.w305).toMatchObject({
    kind: "question",
    content: { needsInput: expect.stringContaining("저작권") },
  });

  // When the user withdraws the #305 stage-2 request, idle classification succeeds without demanding an integration commit receipt!
  const w305 = agents.find(a => a.id === "w305")!;
  w305.updatedAt = "2026-11-26T06:40:00Z";
  timelines.get("w305")!.push("사용자 요청 철회를 확인했습니다. 2단계 자료 대기 없이 대기합니다.");
  const withdrawn305 = JSON.parse(await run("read_board_conversation", { sessionId: "w305" }));
  await run("classify_board_conversation", {
    sessionId: "w305",
    evidenceId: withdrawn305.evidenceId,
    kind: "idle",
    text: "#305 사용자 요청 철회 확인, 남은 결정 없음.",
  });
  expect(prefs.read().judgments.w305).toMatchObject({ kind: "idle", evidenceId: withdrawn305.evidenceId });
});

test("charter, existing-session template, digest prompts, and board tool descriptions align on initial assignment and integration retrieval", async () => {
  const { tool } = await openIssueBoard();
  const charter = buildCoordinatorSystemPrompt("/dev/null");
  const template = readFileSync(new URL("../../templates/coordinator-session.md", import.meta.url), "utf8");

  for (const doc of [charter, template]) {
    expect(doc).toContain("worktree");
    expect(doc).toContain("local_checkout");
    expect(doc).toContain("NOT_PLANNED");
    expect(doc).toContain("workspaceId");
    expect(doc).toMatch(/완료 영수증.*완료·종결로 판정하지/);
    expect(doc).toMatch(/통합 커밋 없이.*NOT_PLANNED/);
    expect(doc).toMatch(/정리 인계/);
  }

  expect(digestPrompt).toContain("NOT_PLANNED");
  expect(digestPrompt).toMatch(/통합 커밋 없이.*NOT_PLANNED/);
  expect(digestPrompt).toMatch(/완료·종결로 판정하지/);
  expect(digestPrompt).toContain("정리 인계");
  expect(englishDigestPrompt).toContain("NOT_PLANNED");
  expect(englishDigestPrompt).toMatch(/without requiring an integration commit/i);
  expect(englishDigestPrompt).toMatch(/without receipts/i);
  expect(englishDigestPrompt).toMatch(/cleanup handoff/i);

  expect(tool("plan_board_assignment").description).toMatch(/worktree/i);
  expect(tool("plan_board_assignment").description).toContain("workspaceId");
  expect(tool("assign_board_worker").description).toMatch(/worktree/i);
  expect(tool("assign_board_worker").description).toMatch(/investigation/i);
  expect(tool("read_board_conversation").description).toContain("workspaceId");
  expect(tool("read_board_conversation").description).toContain("judgment");
  expect(tool("classify_board_conversation").description).toContain("NOT_PLANNED");
  expect(tool("classify_board_conversation").description).toMatch(/cleanup handoff/i);
  expect(tool("classify_board_conversation").description).toMatch(/without verified receipts/i);
});

test("PD-1: coordinator idle judgment on newer evidence supersedes earlier agent-note persistently across unrelated turns while preserving new reports, person-notes, legacy notes, same-evidence notes, and clarifications", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-pd1-"));
  dirs.push(dir);
  const prefs = new PreferenceStore(join(dir, "scope.json"));
  const notes = new NoteStore(join(dir, "notes.json"));
  prefs.change(scope => { scope.projects = ["easydocs"]; scope.coordinator = "coord"; });

  const ev1 = excerpt({ epoch: "1", entries: [{ seqEnd: 1, item: { type: "assistant_message", text: "#308 H1 확인을 부탁드립니다." } }] });
  const ev2 = excerpt({
    epoch: "1",
    entries: [
      { seqEnd: 1, item: { type: "assistant_message", text: "#308 H1 확인을 부탁드립니다." } },
      { seqEnd: 2, item: { type: "assistant_message", text: "#308 cf6f661 원격 main 통합·최종검증·GitHub COMPLETED 확인." } },
    ],
  });
  const ev3 = excerpt({
    epoch: "1",
    entries: [
      { seqEnd: 1, item: { type: "assistant_message", text: "#308 H1 확인을 부탁드립니다." } },
      { seqEnd: 2, item: { type: "assistant_message", text: "#308 cf6f661 원격 main 통합·최종검증·GitHub COMPLETED 확인." } },
      { seqEnd: 3, item: { type: "assistant_message", text: "다음 요청을 기다립니다." } },
    ],
  });

  const baseRow = (id: string, ev: typeof ev1): SessionRow => ({
    id,
    title: "#308 구현",
    projectId: "easydocs",
    projectTitle: "EasyDocs",
    workspaceId: "wks_308",
    workspaceTitle: "EasyDocs #308",
    model: null,
    status: "idle",
    lane: "idle",
    detail: "다음 요청 대기",
    evidenceId: ev.id,
  });

  const evaluate = (row: SessionRow, ev: typeof ev1) => {
    const scope = prefs.read();
    const note = notes.visible(new Set([row.id]))[row.id];
    const judgment = scope.judgments[row.id];
    Object.assign(row, classify(ev, row, judgment?.projectId === row.projectId ? judgment : undefined), { evidenceId: ev.id });
    decorateDecision(row, note, scope, ev);
    return { row, note, lane: displayLane(row, note), count: decisionCount({ sessions: [row], notes: note ? { [row.id]: note } : {} }) };
  };

  // 1. Worker posts an agent-note (question) bound to ev1 -> active before coordinator idle judgment.
  expect(recordReport(notes, "w308", { kind: "question", text: "#308 H1 확인해 주세요" }, ev1.id).isError).not.toBe(true);
  const before = evaluate(baseRow("w308", ev1), ev1);
  expect(before.row.agentNoteSuperseded).toBeUndefined();
  expect(before.row.decision).toMatchObject({ source: "agent-note", question: "#308 H1 확인해 주세요" });
  expect(before.lane).toBe("human");
  expect(before.count).toBe(1);
  expect(sessionClarificationCard(before.row, before.note)).not.toBeNull();

  // 2. Same evidenceId with coordinator idle judgment does NOT supersede the agent-note.
  prefs.change(s => { s.judgments.w308 = { projectId: "easydocs", evidenceId: ev1.id, kind: "idle", text: "동일 근거 대기" }; });
  const sameEv = evaluate(baseRow("w308", ev1), ev1);
  expect(sameEv.row.agentNoteSuperseded).toBeUndefined();
  expect(sameEv.lane).toBe("human");
  expect(sameEv.count).toBe(1);

  // 3. Newer evidence ev2 with coordinator idle judgment (binding supersededAgentNote rev 1) supersedes the ev1 agent-note!
  prefs.change(s => {
    s.judgments.w308 = {
      projectId: "easydocs",
      evidenceId: ev2.id,
      kind: "idle",
      text: "#308 cf6f661 통합 완료",
      supersededAgentNote: { revision: 1, evidenceId: ev1.id },
    };
  });
  const after = evaluate(baseRow("w308", ev2), ev2);
  expect(after.row.agentNoteSuperseded).toBe(true);
  expect(after.row.decision).toBeUndefined();
  expect(after.lane).toBe("idle");
  expect(after.count).toBe(0);
  expect(sessionClarificationCard(after.row, after.note)).toBeNull();
  // Revision is preserved in notes.json so NoteEditor edits will not conflict.
  expect(after.note?.revision).toBe(1);

  // 4. Unrelated follow-up turn ev3 (without a new report_to_board) does NOT resurrect the superseded rev-1 agent-note!
  const unrelatedTurn = evaluate(baseRow("w308", ev3), ev3);
  expect(unrelatedTurn.row.agentNoteSuperseded).toBe(true);
  expect(unrelatedTurn.row.decision).toBeUndefined();
  expect(unrelatedTurn.lane).toBe("idle");
  expect(unrelatedTurn.count).toBe(0);

  // 4b. While the session is running (idle -> running -> idle, evidenceId absent), superseded rev-1 agent-note stays suppressed (0 -> 0 -> 0)!
  const runningRow: SessionRow = {
    id: "w308",
    title: "#308 구현",
    projectId: "easydocs",
    projectTitle: "EasyDocs",
    workspaceId: "wks_308",
    workspaceTitle: "EasyDocs #308",
    model: null,
    status: "running",
    lane: "running",
    detail: "작업 중",
  };
  const runningScope = prefs.read();
  const runningNote = notes.visible(new Set(["w308"])).w308;
  decorateDecision(runningRow, runningNote, runningScope);
  expect(runningRow.agentNoteSuperseded).toBe(true);
  expect(runningRow.decision).toBeUndefined();
  expect(displayLane(runningRow, runningNote)).toBe("running");
  expect(decisionCount({ sessions: [runningRow], notes: { w308: runningNote } })).toBe(0);

  // 5. A brand-new report_to_board on ev3 (incrementing revision to 2) immediately becomes active!
  expect(recordReport(notes, "w308", { kind: "question", text: "새 후속 확인이 필요합니다." }, ev3.id).isError).not.toBe(true);
  const newReport = evaluate(baseRow("w308", ev3), ev3);
  expect(newReport.note?.revision).toBe(2);
  expect(newReport.row.agentNoteSuperseded).toBeUndefined();
  expect(newReport.row.decision).toMatchObject({ source: "agent-note", question: "새 후속 확인이 필요합니다." });
  expect(newReport.lane).toBe("human");
  expect(newReport.count).toBe(1);

  // 6. Also supersedes earlier agent-note with kind: "review" (exact #308 shape).
  expect(recordReport(notes, "w308r", { kind: "review", text: "#308 H1 확인" }, ev1.id).isError).not.toBe(true);
  prefs.change(s => {
    s.judgments.w308r = {
      projectId: "easydocs",
      evidenceId: ev2.id,
      kind: "idle",
      text: "#308 통합 완료",
      supersededAgentNote: { revision: 1, evidenceId: ev1.id },
    };
  });
  const afterReview = evaluate(baseRow("w308r", ev2), ev2);
  expect(afterReview.row.agentNoteSuperseded).toBe(true);
  expect(afterReview.lane).toBe("idle");

  // 7. Human-written person-note is NEVER superseded by coordinator idle judgment.
  notes.update({ sessionId: "person1", kind: "question", text: "사람이 직접 적은 확인", evidenceId: ev1.id, expectedRevision: 0 }, "person");
  prefs.change(s => { s.judgments.person1 = { projectId: "easydocs", evidenceId: ev2.id, kind: "idle", text: "정리됨" }; });
  const personRes = evaluate(baseRow("person1", ev2), ev2);
  expect(personRes.row.agentNoteSuperseded).toBeUndefined();
  expect(personRes.row.decision).toMatchObject({ source: "person-note", question: "사람이 직접 적은 확인" });
  expect(personRes.lane).toBe("human");
  expect(personRes.count).toBe(1);

  // 8. Legacy agent-note without evidenceId stays active (fail-closed).
  expect(recordReport(notes, "legacy1", { kind: "question", text: "레거시 보고" }).isError).not.toBe(true);
  prefs.change(s => { s.judgments.legacy1 = { projectId: "easydocs", evidenceId: ev2.id, kind: "idle", text: "정리됨" }; });
  const legacyRes = evaluate(baseRow("legacy1", ev2), ev2);
  expect(legacyRes.row.agentNoteSuperseded).toBeUndefined();
  expect(legacyRes.lane).toBe("human");
  expect(legacyRes.count).toBe(1);

  // 9. Clarification explanation turn classified idle still restores the original agent-note decision!
  const clarifyMessageId = "11111111-1111-4111-8111-111111111111";
  const clarifyEv = excerpt({
    epoch: "1",
    entries: [
      { seqEnd: 1, item: { type: "assistant_message", text: "#308 H1 확인을 부탁드립니다." } },
      { seqEnd: 2, item: { type: "user_message", text: "[Coordinator Board · 추가 질문]\n어느 버튼인가요?", messageId: clarifyMessageId } },
      { seqEnd: 3, item: { type: "assistant_message", text: "2열 하단 사진 교체 버튼입니다." } },
    ],
  });
  expect(recordReport(notes, "clarify1", { kind: "question", text: "#308 H1 확인해 주세요" }, ev1.id).isError).not.toBe(true);
  const initialClarify = evaluate(baseRow("clarify1", ev1), ev1);
  const clarifyCard = {
    kind: "session" as const,
    projectId: "easydocs",
    sessionId: "clarify1",
    version: initialClarify.row.decision!.version,
  };
  prefs.change(s => {
    s.judgments.clarify1 = { projectId: "easydocs", evidenceId: clarifyEv.id, kind: "idle", text: "설명 응답" };
    s.clarifications[clarifyMessageId] = {
      cardKey: JSON.stringify(["session", "easydocs", "clarify1", initialClarify.row.decision!.version]),
      messageId: clarifyMessageId,
      recipientId: "clarify1",
      question: "어느 버튼인가요?",
      at: "2026-11-26T05:00:00Z",
      status: "sent",
      card: clarifyCard,
      fingerprint: "f".repeat(64),
      bodyHash: "b".repeat(64),
      sourceSessionId: "clarify1",
      savedDecision: initialClarify.row.decision!,
      noteRevision: 1,
      sourceEvidenceId: ev1.id,
    };
  });
  const clarifyRow = baseRow("clarify1", clarifyEv);
  const clarifyScope = prefs.read();
  const clarifyNote: Note | undefined = notes.visible(new Set(["clarify1"])).clarify1;
  Object.assign(clarifyRow, classify(clarifyEv, clarifyRow, clarifyScope.judgments.clarify1), { evidenceId: clarifyEv.id });
  expect(isSupersededAgentNote(clarifyRow, clarifyNote, clarifyScope)).toBe(true);
  decorateDecision(clarifyRow, clarifyNote, clarifyScope, clarifyEv);
  restoreClarifiedDecision(clarifyRow, clarifyNote, clarifyScope, clarifyEv);
  expect(clarifyRow.agentNoteSuperseded).toBeUndefined();
  expect(clarifyRow.lane).toBe("human");
  expect(clarifyRow.decision).toEqual(initialClarify.row.decision);
  expect(displayLane(clarifyRow, clarifyNote)).toBe("human");
});
