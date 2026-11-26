import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachCoordinatorTools } from "../../server/coordinator";
import { ConversationReader } from "../../server/conversation";
import { digestPrompt, englishDigestPrompt } from "../../server/digest";
import { buildCoordinatorSystemPrompt } from "../../server/lifecycle";
import { NoteStore } from "../../server/notes";
import { createOperations } from "../../server/operations";
import { PreferenceStore } from "../../server/preferences";
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

  // 1. Pre-integration state: worker reported H1 review note and coordinator classified review wait.
  notes.update({ sessionId: "w308", kind: "review", text: "#308 사람 확인 H1", expectedRevision: 0 }, "agent");
  const initialExcerpt = JSON.parse(await run("read_board_conversation", { sessionId: "w308" }));
  await run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: initialExcerpt.evidenceId,
    kind: "review",
    text: "#308 사진 교체 버튼 H1 확인을 e9fe346에 기록했습니다. 운영 세션의 실제 통합 결과 최종검증이 남았습니다.",
  });

  // Listing surfaces workspaceId, stale review judgment, and active agent note.
  const listed = JSON.parse(await run("read_board_conversation"));
  expect(listed.find((r: { id: string }) => r.id === "w308")).toMatchObject({
    workspaceId: "wks_308",
    workspaceTitle: "EasyDocs #308 · 2열 사진 교체 구현",
    judgment: { kind: "review", evidenceId: initialExcerpt.evidenceId },
    note: { kind: "review", origin: "agent" },
  });

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

  // 3. Worker finishes /done with integration receipt + separate cleanup handoff.
  w308.updatedAt = "2026-11-26T06:37:05Z";
  timelines.get("w308")!.push(
    "#308 마무리 점검과 정리 인계를 완료했습니다. cf6f661 원격 main 반영·D155 최종검증 통과·GitHub COMPLETED 확인. workspace 정리 인계는 별도 보존·사용 종료 대기.",
  );

  // Reusing the pre-integration evidenceId is rejected.
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: initialExcerpt.evidenceId,
    kind: "idle",
    text: "#308 cf6f661 통합 완료",
  })).rejects.toThrow(/대화가 바뀌었습니다/);

  // Re-reading latest evidenceId succeeds and replaces the stale review judgment.
  const latestExcerpt = JSON.parse(await run("read_board_conversation", { sessionId: "w308" }));
  expect(latestExcerpt.evidenceId).not.toBe(initialExcerpt.evidenceId);
  await run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: latestExcerpt.evidenceId,
    kind: "idle",
    text: "#308 cf6f661 원격 main 통합·최종검증·GitHub COMPLETED 확인. workspace 정리 인계(보존 대조·사용 종료 대기)는 별도 추적.",
  });

  const updated = JSON.parse(await run("read_board_conversation"));
  expect(updated.find((r: { id: string }) => r.id === "w308").judgment).toEqual({
    kind: "idle",
    evidenceId: latestExcerpt.evidenceId,
  });
});

test("#303 NOT_PLANNED and #305 staged human decision are classified cleanly with distinct outcomes", async () => {
  const { prefs, run } = await openIssueBoard();

  const e303 = JSON.parse(await run("read_board_conversation", { sessionId: "w303" }));
  await run("classify_board_conversation", {
    sessionId: "w303",
    evidenceId: e303.evidenceId,
    kind: "idle",
    text: "#303 라이선스 우선순위 미정으로 조사 중단 · GitHub NOT_PLANNED 종료(해결 완료 아님, 공유 main 보존).",
  });

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
    expect(doc).toMatch(/완료 영수증.*완료로 판정하지/);
    expect(doc).toMatch(/정리 인계/);
  }

  expect(digestPrompt).toContain("NOT_PLANNED");
  expect(digestPrompt).toMatch(/완료로 판정하지/);
  expect(digestPrompt).toContain("정리 인계");
  expect(englishDigestPrompt).toContain("NOT_PLANNED");
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
  expect(tool("classify_board_conversation").description).toMatch(/without verified evidence or receipts/i);
});
