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
import {
  createOutcomeVerifier,
  summarizeCommitChecks,
  type CommitVerification,
  type IssueOutcome,
  type OutcomeVerifier,
} from "../../server/outcome-verifier";
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

async function openIssueBoard(options: {
  onVerifyIssue?: () => void;
  onWorkspaceRefresh?: (count: number) => void;
  onAgentsList?: (count: number) => void;
  onTimelineRefetch?: (id: string, count: number) => void;
} = {}) {
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
      gitRuntime: { currentBranch: "main", remoteUrl: "https://github.com/acme/EasyDocs.git" },
    },
    {
      id: "wks_308",
      projectId: "easydocs",
      title: "EasyDocs #308 · 2열 사진 교체 구현",
      name: "easydocs-308",
      workspaceKind: "worktree" as const,
      workspaceDirectory: "/synthetic/worktrees/easydocs-308",
      gitRuntime: { currentBranch: "feat/two-col-photo-replace-308", remoteUrl: "https://github.com/acme/EasyDocs.git" },
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

  const issueStates = new Map<string, IssueOutcome>([
    ["acme/easydocs#308", { state: "OPEN", stateReason: "UNKNOWN", url: "https://github.com/acme/easydocs/issues/308" }],
    ["acme/easydocs#303", { state: "CLOSED", stateReason: "NOT_PLANNED", url: "https://github.com/acme/easydocs/issues/303" }],
    ["acme/easydocs#999", { state: "CLOSED", stateReason: "COMPLETED", url: "https://github.com/acme/easydocs/issues/999" }],
    ["other/easydocs#308", { state: "CLOSED", stateReason: "COMPLETED", url: "https://github.com/other/easydocs/issues/308" }],
  ]);
  const commitStates = new Map<string, CommitVerification>([
    ["acme/easydocs@cf6f661", { onMain: false, resolvedSha: "cf6f661000000000000000000000000000000000", checks: "pending" }],
    ["acme/easydocs@e9fe346", { onMain: false, resolvedSha: "e9fe346000000000000000000000000000000000", checks: "passed" }],
  ]);

  const verifier: OutcomeVerifier = {
    async verifyIssue(repo, issue) {
      options.onVerifyIssue?.();
      return issueStates.get(`${repo.toLowerCase()}#${issue}`) ?? { state: "UNKNOWN", stateReason: "UNKNOWN" };
    },
    async verifyMainCommit(_workspacePath, repo, commit) {
      return commitStates.get(`${repo.toLowerCase()}@${commit.toLowerCase()}`) ?? { onMain: false, checks: "unavailable" };
    },
  };

  let wsRefreshCount = 0;
  let agentsListCount = 0;
  let timelineRefetchCount = 0;
  const page = <T,>(entries: T[]) => ({ entries, pageInfo: { hasMore: false, nextCursor: null } });
  const sdk = {
    projects: {
      list: async () => ({
        projects: [{ projectId: "easydocs", projectDisplayName: "EasyDocs", projectRootPath: "/synthetic/EasyDocs" }],
      }),
    },
    workspaces: {
      list: async () => page(workspaces),
      ref: (id: string) => ({
        refresh: async () => {
          wsRefreshCount += 1;
          options.onWorkspaceRefresh?.(wsRefreshCount);
          return workspaces.find(w => w.id === id) ?? null;
        },
      }),
    },
    agents: {
      list: async () => {
        agentsListCount += 1;
        options.onAgentsList?.(agentsListCount);
        return page(agents.map(agent => ({ agent, project: { projectKey: "easydocs", projectName: "EasyDocs" } })));
      },
      ref: (id: string) => ({
        timeline: {
          refetch: async () => {
            timelineRefetchCount += 1;
            options.onTimelineRefetch?.(id, timelineRefetchCount);
            return {
              epoch: "1",
              entries: (timelines.get(id) ?? []).map((text, index) => ({
                seqEnd: index + 1,
                timestamp: agents.find(a => a.id === id)?.updatedAt,
                item: { type: "assistant_message", text },
              })),
            };
          },
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
    { addHook: (_name: string, fn: any) => { onOpen = fn; } } as any,
    prefs,
    new ConversationReader(),
    ops.tools,
    notes,
    verifier,
  );
  const opened = await onOpen!({ request: { purpose: "interactive", agentId: "coord", tools: [] } });
  const tool = (name: string) => opened.tools.find((t: { name: string }) => t.name === name);
  const run = async (name: string, input: Record<string, unknown> = {}) =>
    (await tool(name).execute(input, { paseo: sdk, agent: { id: "coord" } })).text;

  return { prefs, notes, workspaces, agents, timelines, issueStates, commitStates, tool, run };
}

test("plan_board_assignment exposes workspace kind, branch, path and session workspaceId for direct worktree assignment and owner reuse", async () => {
  const { run } = await openIssueBoard();
  const plan = JSON.parse(await run("plan_board_assignment", { projectId: "easydocs" }));

  expect(plan.workspaces).toEqual([
    {
      id: "wks_main",
      projectId: "easydocs",
      title: "EasyDocs · main",
      kind: "local_checkout",
      branch: "main",
      path: "/synthetic/EasyDocs",
    },
    {
      id: "wks_308",
      projectId: "easydocs",
      title: "EasyDocs #308 · 2열 사진 교체 구현",
      kind: "worktree",
      branch: "feat/two-col-photo-replace-308",
      path: "/synthetic/worktrees/easydocs-308",
    },
  ]);

  expect(plan.sessions.find((s: { id: string }) => s.id === "w308")).toMatchObject({
    id: "w308",
    workspaceId: "wks_308",
    workspaceTitle: "EasyDocs #308 · 2열 사진 교체 구현",
  });
  expect(plan.sessions.find((s: { id: string }) => s.id === "w303")).toMatchObject({
    id: "w303",
    workspaceId: "wks_main",
  });
});

test("#308 reproduction: structured receipt verification blocks unverified completions and clears pre-integration wait once verified", async () => {
  const { prefs, notes, agents, timelines, issueStates, commitStates, run } = await openIssueBoard();
  const w308 = agents.find(a => a.id === "w308")!;

  // 1. Pre-integration state: worker reported H1 review note (with reference issue #999) and coordinator classified review wait.
  const initialExcerpt = JSON.parse(await run("read_board_conversation", { sessionId: "w308" }));
  expect(recordReport(notes, "w308", { kind: "review", text: "#308 사람 확인 H1 (참고 이슈 #999)" }, initialExcerpt.evidenceId).isError).not.toBe(true);
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

  // Fail-closed: omitting receipt or trying to abuse `withdrawn` on a review wait is rejected.
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: initialExcerpt.evidenceId,
    kind: "idle",
    text: "#308 완료",
  })).rejects.toThrow(/완료 영수증·검증 근거/);
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: initialExcerpt.evidenceId,
    kind: "idle",
    text: "#308 정리",
    receipt: { kind: "withdrawn", reason: "임의 취소" },
  })).rejects.toThrow(/withdrawn으로 해제할 수 없습니다/);
  expect(prefs.read().judgments.w308.kind).toBe("review");

  const baseReceipt = {
    kind: "completed" as const,
    repo: "acme/easydocs",
    issue: 308,
    commit: "cf6f661",
    verifiedCommit: "cf6f661",
    verification: { source: "ci" as const, status: "passed" as const, summary: "CI 통과" },
    closeReason: "COMPLETED" as const,
  };

  // Foreign repo (same leaf name other/easydocs) or wrong issue (#999) is rejected deterministically.
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: initialExcerpt.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: { ...baseReceipt, repo: "other/easydocs" },
  })).rejects.toThrow(/영수증 저장소/);
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: initialExcerpt.evidenceId,
    kind: "idle",
    text: "#999 통합 완료",
    receipt: { ...baseReceipt, issue: 999 },
  })).rejects.toThrow(/영수증 이슈/);

  // OPEN issue or reason-less CLOSED (UNKNOWN) is rejected.
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: initialExcerpt.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: baseReceipt,
  })).rejects.toThrow(/COMPLETED 종료가 확인되지 않아/);
  issueStates.set("acme/easydocs#308", { state: "CLOSED", stateReason: "UNKNOWN" });
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: initialExcerpt.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: baseReceipt,
  })).rejects.toThrow(/COMPLETED 종료가 확인되지 않아/);

  // Close issue #308 as COMPLETED, but commit cf6f661 is still only on a feature branch (onMain: false) -> rejected.
  issueStates.set("acme/easydocs#308", { state: "CLOSED", stateReason: "COMPLETED" });
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: initialExcerpt.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: baseReceipt,
  })).rejects.toThrow(/main 브랜치에 반영/);

  // 2. Integration finishes while w308 is running /done -> fail-closed with actionable running message.
  w308.status = "running";
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: initialExcerpt.evidenceId,
    kind: "idle",
    text: "#308 cf6f661 통합 완료",
    receipt: baseReceipt,
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
    receipt: baseReceipt,
  })).rejects.toThrow(/권한 응답 대기/);
  w308.pendingPermissions = [];

  // 3. Worker finishes /done with integration commit cf6f661 + comparison commit e9fe346 + cleanup hold + unrelated doc task waiting!
  w308.updatedAt = "2026-11-26T06:37:05Z";
  timelines.get("w308")!.push(
    "#308 마무리 점검과 정리 인계를 완료했습니다. 실제 통합 커밋은 cf6f661입니다. 비교 대상인 예전 커밋은 e9fe346입니다. CI 통과와 GitHub #308 COMPLETED 종료를 확인했지만 현재 작업 폴더는 사용 종료를 확인하지 못해 정리를 보류합니다. 별도 문서 작업은 자료를 기다립니다.",
  );

  // Reusing the pre-integration evidenceId is rejected.
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: initialExcerpt.evidenceId,
    kind: "idle",
    text: "#308 cf6f661 통합 완료",
    receipt: baseReceipt,
  })).rejects.toThrow(/대화가 바뀌었습니다/);

  // Re-reading latest evidenceId, verify pending / failed / unavailable CI checks, unrelated commit e9fe346, and verifiedCommit mismatch are all rejected!
  const latestExcerpt = JSON.parse(await run("read_board_conversation", { sessionId: "w308" }));
  expect(latestExcerpt.evidenceId).not.toBe(initialExcerpt.evidenceId);

  commitStates.set("acme/easydocs@cf6f661", { onMain: true, resolvedSha: "cf6f661000000000000000000000000000000000", checks: "pending" });
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: latestExcerpt.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: baseReceipt,
  })).rejects.toThrow(/검증 상태가 pending/);

  commitStates.set("acme/easydocs@cf6f661", { onMain: true, resolvedSha: "cf6f661000000000000000000000000000000000", checks: "failed" });
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: latestExcerpt.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: { ...baseReceipt, verification: { source: "local", status: "passed", summary: "D155 로컬 통과" } },
  })).rejects.toThrow(/검증 상태가 failed/);

  commitStates.set("acme/easydocs@cf6f661", { onMain: true, resolvedSha: "cf6f661000000000000000000000000000000000", checks: "unavailable" });
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: latestExcerpt.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: baseReceipt,
  })).rejects.toThrow(/통과된 CI 체크를 확인할 수 없어/);

  commitStates.set("acme/easydocs@cf6f661", { onMain: true, resolvedSha: "cf6f661000000000000000000000000000000000", checks: "passed" });
  commitStates.set("acme/easydocs@e9fe346", { onMain: true, resolvedSha: "e9fe346000000000000000000000000000000000", checks: "passed" });
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: latestExcerpt.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: { ...baseReceipt, commit: "e9fe346", verifiedCommit: "e9fe346" },
  })).rejects.toThrow(/통합 근거와 연결되지 않아/);
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: latestExcerpt.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: { ...baseReceipt, verifiedCommit: "e9fe346" },
  })).rejects.toThrow(/검증 커밋.*일치하지 않아/);
  expect(prefs.read().judgments.w308.kind).toBe("review");
  await run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: latestExcerpt.evidenceId,
    kind: "idle",
    text: "#308 cf6f661 원격 main 통합·CI 통과·GitHub COMPLETED 확인. workspace 정리 인계는 별도 추적.",
    receipt: {
      ...baseReceipt,
      cleanupHandoff: "현재 작업 폴더는 사용 종료를 확인하지 못해 정리를 보류합니다.",
    },
  });

  const updated = JSON.parse(await run("read_board_conversation"));
  const row308 = updated.find((r: { id: string }) => r.id === "w308");
  expect(row308.judgment).toEqual({
    kind: "idle",
    evidenceId: latestExcerpt.evidenceId,
  });
  expect(row308.note).toBeUndefined();
});

test("#303 NOT_PLANNED (verified vs OPEN/wrong-issue) and #305 staged human decision (including withdrawal) are handled cleanly", async () => {
  const { prefs, agents, timelines, issueStates, run } = await openIssueBoard();
  const e303 = JSON.parse(await run("read_board_conversation", { sessionId: "w303" }));

  const receipt303 = {
    kind: "not_planned" as const,
    repo: "acme/easydocs",
    issue: 303,
    closeReason: "NOT_PLANNED" as const,
    stopReason: "라이선스 우선순위 미정으로 조사 중단",
  };

  // Mislabeling a NOT_PLANNED stop as a resolved fix without mentioning NOT_PLANNED/중단 is rejected.
  await expect(run("classify_board_conversation", {
    sessionId: "w303",
    evidenceId: e303.evidenceId,
    kind: "idle",
    text: "#303 원인 해결 완료",
    receipt: receipt303,
  })).rejects.toThrow(/NOT_PLANNED/);

  // Another issue (#999) cannot stand in for #303.
  await expect(run("classify_board_conversation", {
    sessionId: "w303",
    evidenceId: e303.evidenceId,
    kind: "idle",
    text: "#303 NOT_PLANNED 종료",
    receipt: { ...receipt303, issue: 999 },
  })).rejects.toThrow(/영수증 이슈/);

  // OPEN issue proposing NOT_PLANNED closure is rejected fail-closed.
  issueStates.set("acme/easydocs#303", { state: "OPEN", stateReason: "UNKNOWN" });
  await expect(run("classify_board_conversation", {
    sessionId: "w303",
    evidenceId: e303.evidenceId,
    kind: "idle",
    text: "#303 NOT_PLANNED 종료",
    receipt: receipt303,
  })).rejects.toThrow(/NOT_PLANNED 종료가 확인되지 않아/);

  // Confirmed GitHub CLOSED/NOT_PLANNED succeeds without requiring an integration commit.
  issueStates.set("acme/easydocs#303", { state: "CLOSED", stateReason: "NOT_PLANNED" });
  await run("classify_board_conversation", {
    sessionId: "w303",
    evidenceId: e303.evidenceId,
    kind: "idle",
    text: "#303 라이선스 우선순위 미정으로 조사 중단 · GitHub NOT_PLANNED 종료(해결 완료 아님, 공유 main 보존).",
    receipt: receipt303,
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

  // Cannot clear an open question with arbitrary `withdrawn` while the conversation still asks for input!
  await expect(run("classify_board_conversation", {
    sessionId: "w305",
    evidenceId: e305.evidenceId,
    kind: "idle",
    text: "#305 철회",
    receipt: { kind: "withdrawn", reason: "임의 철회" },
  })).rejects.toThrow(/열린 질문과 같은 발췌|철회·취소 근거/);

  const w305 = agents.find(a => a.id === "w305")!;
  w305.updatedAt = "2026-11-26T06:35:00Z";
  timelines.get("w305")!.push("공식 CE/UL 안전문 원문을 확인해 주세요.");
  const stillAsking305 = JSON.parse(await run("read_board_conversation", { sessionId: "w305" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w305",
    evidenceId: stillAsking305.evidenceId,
    kind: "idle",
    text: "#305 철회",
    receipt: { kind: "withdrawn", reason: "임의 철회" },
  })).rejects.toThrow(/철회·취소 근거/);

  // Checking whether the user withdrew ("철회 여부를 확인 중입니다") is also rejected fail-closed!
  w305.updatedAt = "2026-11-26T06:37:00Z";
  timelines.get("w305")!.push("사용자 요청 철회 여부를 확인 중입니다.");
  const checkingWithdraw305 = JSON.parse(await run("read_board_conversation", { sessionId: "w305" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w305",
    evidenceId: checkingWithdraw305.evidenceId,
    kind: "idle",
    text: "#305 철회",
    receipt: { kind: "withdrawn", reason: "임의 철회" },
  })).rejects.toThrow(/철회·취소 근거/);

  // Separate-task withdrawal while the original decision is still needed is also rejected fail-closed!
  w305.updatedAt = "2026-11-26T06:38:00Z";
  timelines.get("w305")!.push("별도 문서 작업 요청의 철회를 확인했습니다. H1 판단은 여전히 필요합니다.");
  const separateWithdraw305 = JSON.parse(await run("read_board_conversation", { sessionId: "w305" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w305",
    evidenceId: separateWithdraw305.evidenceId,
    kind: "idle",
    text: "#305 철회",
    receipt: { kind: "withdrawn", reason: "임의 철회" },
  })).rejects.toThrow(/철회·취소 근거/);

  // Withdrawing a DIFFERENT request within the same issue, even if another sentence mentions the open question's topic, is rejected!
  w305.updatedAt = "2026-11-26T06:39:00Z";
  timelines.get("w305")!.push("#305의 배포 일정 변경 요청이 취소됐습니다. 2단계 자료에 관한 문서를 첨부합니다.");
  const otherRequestWithdraw305 = JSON.parse(await run("read_board_conversation", { sessionId: "w305" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w305",
    evidenceId: otherRequestWithdraw305.evidenceId,
    kind: "idle",
    text: "#305 철회",
    receipt: { kind: "withdrawn", reason: "배포 일정 변경 취소" },
  })).rejects.toThrow(/철회·취소 근거/);

  // When the user withdraws the #305 stage-2 request, idle classification succeeds without demanding an integration commit receipt!
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

test("createOutcomeVerifier validates GitHub issue URL/stateReason, remote-only main ancestry, and non-skipped commit check rollup fail-closed", async () => {
  expect(summarizeCommitChecks([], [])).toBe("unavailable");
  expect(summarizeCommitChecks([{ status: "completed", conclusion: "skipped" }], [])).toBe("unavailable");
  expect(summarizeCommitChecks([{ status: "completed", conclusion: "neutral" }], [])).toBe("unavailable");
  expect(summarizeCommitChecks([{ status: "completed", conclusion: "skipped" }, { status: "completed", conclusion: "success" }], [])).toBe("passed");
  expect(summarizeCommitChecks([{ status: "completed", conclusion: "success" }], [])).toBe("passed");
  expect(summarizeCommitChecks([{ status: "in_progress", conclusion: null }], [])).toBe("pending");
  expect(summarizeCommitChecks([{ status: "completed", conclusion: "failure" }], [])).toBe("failed");
  expect(summarizeCommitChecks([{ status: "completed", conclusion: "success" }], [{ state: "pending" }])).toBe("pending");

  const calls: string[] = [];
  const verifier = createOutcomeVerifier(async (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "git") {
      throw new Error("local git branch must never substitute for remote main verification");
    }
    if (cmd === "gh" && args[0] === "issue" && args[2] === "308") {
      return JSON.stringify({
        state: "CLOSED",
        stateReason: "COMPLETED",
        url: "https://github.com/acme/EasyDocs/issues/308",
      });
    }
    if (cmd === "gh" && args[0] === "issue" && args[2] === "309") {
      return JSON.stringify({
        state: "CLOSED",
        stateReason: "COMPLETED",
        url: "https://github.com/other/EasyDocs/issues/309",
      });
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/commits/cf6f661") {
      return "cf6f661000000000000000000000000000000000\n";
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/compare/main...cf6f661000000000000000000000000000000000") {
      return "behind\n";
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/commits/cf6f661000000000000000000000000000000000/check-runs?per_page=100&page=1") {
      return JSON.stringify({ total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] });
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/commits/cf6f661000000000000000000000000000000000/status?per_page=100&page=1") {
      return JSON.stringify({ state: "success", total_count: 0, statuses: [] });
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/commits/aabbccd") {
      return "aabbccd000000000000000000000000000000000\n";
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/compare/main...aabbccd000000000000000000000000000000000") {
      return "behind\n";
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/commits/aabbccd000000000000000000000000000000000/check-runs?per_page=100&page=1") {
      // Truncated page: total_count is 31, only 30 returned, page 2 is empty -> MUST fail closed as unavailable!
      return JSON.stringify({
        total_count: 31,
        check_runs: Array.from({ length: 30 }, () => ({ status: "completed", conclusion: "success" })),
      });
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/commits/aabbccd000000000000000000000000000000000/check-runs?per_page=100&page=2") {
      return JSON.stringify({ total_count: 31, check_runs: [] });
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/commits/aabbccd000000000000000000000000000000000/status?per_page=100&page=1") {
      return JSON.stringify({ state: "success", total_count: 0, statuses: [] });
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/commits/badc0de") {
      return "badc0de000000000000000000000000000000000\n";
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/compare/main...badc0de000000000000000000000000000000000") {
      return "behind\n";
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/commits/badc0de000000000000000000000000000000000/check-runs?per_page=100&page=1") {
      return JSON.stringify({ total_count: 1, check_runs: [{ status: "completed", conclusion: "failure" }] });
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/commits/badc0de000000000000000000000000000000000/status?per_page=100&page=1") {
      throw new Error("status endpoint unavailable");
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/commits/deadbee") {
      throw new Error("Not Found");
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
  });

  expect(await verifier.verifyIssue("acme/easydocs", 308)).toEqual({
    state: "CLOSED",
    stateReason: "COMPLETED",
    url: "https://github.com/acme/EasyDocs/issues/308",
  });
  expect(await verifier.verifyIssue("acme/easydocs", 309)).toEqual({
    state: "UNKNOWN",
    stateReason: "UNKNOWN",
  });
  // Even when a local workspacePath is supplied, remote GitHub ancestry is verified (never bypassed by local git main).
  expect(await verifier.verifyMainCommit("/synthetic/EasyDocs", "acme/easydocs", "deadbee")).toEqual({
    onMain: false,
    checks: "unavailable",
  });
  // Observed FAILURE in check-runs MUST stay "failed" even if the sibling status endpoint errors!
  expect(await verifier.verifyMainCommit("/synthetic/EasyDocs", "acme/easydocs", "badc0de")).toEqual({
    onMain: true,
    resolvedSha: "badc0de000000000000000000000000000000000",
    checks: "failed",
  });
  // Incomplete check-runs pagination (total_count: 31, only 30 received) fails closed as unavailable!
  expect(await verifier.verifyMainCommit("/synthetic/EasyDocs", "acme/easydocs", "aabbccd")).toEqual({
    onMain: true,
    resolvedSha: "aabbccd000000000000000000000000000000000",
    checks: "unavailable",
  });
  expect(await verifier.verifyMainCommit("/synthetic/EasyDocs", "acme/easydocs", "cf6f661")).toEqual({
    onMain: true,
    resolvedSha: "cf6f661000000000000000000000000000000000",
    checks: "passed",
  });
  expect(calls.every(c => c.startsWith("gh "))).toBe(true);
});

test("classify_board_conversation rejects unanchored receipts and mid-verification TOCTOU (new report, remote change, resume, or new turn during final check)", async () => {
  let midVerifyAction: (() => void) | undefined;
  let finalRefreshAction: (() => void) | undefined;
  let finalListAction: (() => void) | undefined;
  let finalTimelineAction: (() => void) | undefined;
  const { prefs, notes, workspaces, agents, timelines, issueStates, commitStates, run } = await openIssueBoard({
    onVerifyIssue: () => midVerifyAction?.(),
    onWorkspaceRefresh: (count) => {
      if (count % 2 === 0) finalRefreshAction?.();
    },
    onAgentsList: () => finalListAction?.(),
    onTimelineRefetch: () => finalTimelineAction?.(),
  });
  const w308 = agents.find(a => a.id === "w308")!;
  issueStates.set("acme/easydocs#308", { state: "CLOSED", stateReason: "COMPLETED" });
  commitStates.set("acme/easydocs@cf6f661", { onMain: true, resolvedSha: "cf6f661000000000000000000000000000000000", checks: "passed" });

  const validReceipt = {
    kind: "completed" as const,
    repo: "acme/easydocs",
    issue: 308,
    commit: "cf6f661",
    verifiedCommit: "cf6f661",
    verification: { source: "ci" as const, status: "passed" as const, summary: "CI 통과" },
    closeReason: "COMPLETED" as const,
  };

  // 1. Unanchored session cannot adopt #999 from the closing turn itself ("다른 작업 #999의 종료 결과를 조회했습니다")!
  w308.title = "사진 교체 구현";
  workspaces[1].title = "EasyDocs 사진 교체 작업";
  timelines.set("w308", ["다른 작업 #999의 종료 결과를 조회했습니다."]);
  const unanchoredEv = JSON.parse(await run("read_board_conversation", { sessionId: "w308" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: unanchoredEv.evidenceId,
    kind: "idle",
    text: "완료",
    receipt: { ...validReceipt, issue: 999 },
  })).rejects.toThrow(/대상 이슈 번호를 확인할 수 없어/);

  // Restore #308 anchor via title and cite cf6f661 in closing turn for TOCTOU tests.
  w308.title = "#308 2열 사진 교체 · 구현";
  workspaces[1].title = "EasyDocs #308 · 2열 사진 교체 구현";
  timelines.set("w308", ["cf6f661 원격 main 반영과 검증을 마쳤습니다."]);
  const ev = JSON.parse(await run("read_board_conversation", { sessionId: "w308" }));

  // 2. New report_to_board arriving during async verification MUST abort idle classification and NEVER be superseded!
  midVerifyAction = () => {
    recordReport(notes, "w308", { kind: "question", text: "검증 중 새 질문이 도착했습니다." }, "other-ev");
  };
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: ev.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: validReceipt,
  })).rejects.toThrow(/세션 보고가 바뀌었습니다/);
  expect(prefs.read().supersededAgentNotes.w308).toBeUndefined();
  expect(prefs.read().judgments.w308).toBeUndefined();

  // 3. Session resuming (`running`) during the final workspace refresh MUST abort idle classification!
  midVerifyAction = undefined;
  finalRefreshAction = () => {
    w308.status = "running";
  };
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: ev.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: validReceipt,
  })).rejects.toThrow(/실행 중인 세션/);
  expect(prefs.read().judgments.w308).toBeUndefined();
  w308.status = "idle";
  finalRefreshAction = undefined;

  // 4. New turn arriving during the final agents.list status check MUST abort idle classification!
  let listCalls = 0;
  finalListAction = () => {
    listCalls += 1;
    if (listCalls === 2) {
      timelines.get("w308")!.push("최종 상태 조회 중 새 발화가 도착했습니다.");
    }
  };
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: ev.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: validReceipt,
  })).rejects.toThrow(/대화가 바뀌었습니다|세션 갱신 시점이 바뀌었습니다/);
  expect(prefs.read().judgments.w308).toBeUndefined();
  finalListAction = undefined;
  timelines.get("w308")!.pop();

  // 4b. Session resuming (`running` + updatedAt advanced) DURING the final timeline.refetch() MUST abort idle classification!
  let refetchCalls = 0;
  finalTimelineAction = () => {
    refetchCalls += 1;
    if (refetchCalls === 2) {
      w308.status = "running";
      w308.updatedAt = "2026-11-26T06:59:59Z";
    }
  };
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: ev.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: validReceipt,
  })).rejects.toThrow(/실행 중인 세션|세션 갱신 시점이 바뀌었습니다/);
  expect(prefs.read().judgments.w308).toBeUndefined();
  finalTimelineAction = undefined;
  w308.status = "idle";
  w308.updatedAt = "2026-11-26T05:50:00Z";

  // 5. Workspace remoteUrl changing to another repository during async verification MUST abort idle classification!
  midVerifyAction = () => {
    workspaces[1].gitRuntime.remoteUrl = "https://github.com/other/EasyDocs.git";
  };
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: ev.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: validReceipt,
  })).rejects.toThrow(/프로젝트 저장소 설정이 바뀌었습니다/);
  expect(prefs.read().judgments.w308).toBeUndefined();
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

  // 3. Newer evidence ev2 with coordinator idle judgment (binding supersededAgentNotes rev 1) supersedes the ev1 agent-note!
  prefs.change(s => {
    s.judgments.w308 = {
      projectId: "easydocs",
      evidenceId: ev2.id,
      kind: "idle",
      text: "#308 cf6f661 통합 완료",
    };
    s.supersededAgentNotes.w308 = { projectId: "easydocs", revision: 1, evidenceId: ev1.id };
  });
  const after = evaluate(baseRow("w308", ev2), ev2);
  expect(after.row.agentNoteSuperseded).toBe(true);
  expect(after.row.decision).toBeUndefined();
  expect(after.lane).toBe("idle");
  expect(after.count).toBe(0);
  expect(sessionClarificationCard(after.row, after.note)).toBeNull();
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

  // 4c. Classifying a separate later turn as `review` keeps the previously superseded rev-1 question suppressed!
  prefs.change(s => {
    s.judgments.w308 = { projectId: "easydocs", evidenceId: ev3.id, kind: "review", text: "별도 후속 작업 결과 확인" };
  });
  const separateReview = evaluate(baseRow("w308", ev3), ev3);
  expect(separateReview.row.agentNoteSuperseded).toBe(true);
  expect(separateReview.row.decision).toBeUndefined();
  expect(separateReview.lane).toBe("review");
  expect(separateReview.count).toBe(0);

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
    };
    s.supersededAgentNotes.w308r = { projectId: "easydocs", revision: 1, evidenceId: ev1.id };
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
