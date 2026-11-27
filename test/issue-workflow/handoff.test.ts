import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachCoordinatorTools, verifyIdleClassification } from "../../server/coordinator";
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
import { attachReportTool, recordReport } from "../../server/reporting";
import { sessionClarificationCard } from "../../shared/clarifications";
import { reportingKey, type Note, type SessionRow } from "../../shared/contract";
import { decisionCount, displayLane } from "../../shared/decision-count";
import contribute from "../../index.server";
import { projectCards } from "../../client/model";
import { decisionSummary } from "../../client/decision-summary";
import { boardSnapshot } from "../../shared/contract";
import { sendDecision } from "../../shared/decision-actions";
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
  const dataDir = join(dir, "plugin-data", "coordinator-board");
  mkdirSync(dataDir, {recursive: true});
  const prefs = new PreferenceStore(join(dataDir, "scope.json"));
  const notes = new NoteStore(join(dataDir, "notes.json"));
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

  const timelines = new Map<string, (string | { role: "user" | "assistant"; text: string })[]>([
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
  const sent: {id: string; text: string}[] = [];
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
        refresh: async () => ({agent: agents.find(a => a.id === id)}),
        send: async (text: string) => { sent.push({id, text}); },
        timeline: {
          refetch: async ({ limit }: {limit: number}) => {
            timelineRefetchCount += 1;
            options.onTimelineRefetch?.(id, timelineRefetchCount);
            return {
              epoch: "1",
              entries: (timelines.get(id) ?? []).map((entry, index) => ({
                seqEnd: index + 1,
                timestamp: agents.find(a => a.id === id)?.updatedAt,
                item: typeof entry === "string"
                  ? { type: "assistant_message", text: entry }
                  : { type: entry.role === "user" ? "user_message" : "assistant_message", text: entry.text },
              })).slice(-limit),
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

  function board() {
    const handlers = new Map<string, (input: any, context: any) => Promise<unknown>>();
    const oldHome = process.env.PASEO_HOME;
    process.env.PASEO_HOME = dir;
    try {
      contribute({handle: (def, fn) => handlers.set(def.name, fn), registerSettings() {}, addHook: () => () => {}} as never);
    } finally {
      if (oldHome === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = oldHome;
    }
    return {
      snapshot: async () => boardSnapshot.output.parse(await handlers.get(boardSnapshot.name)!({fresh: true}, {paseo: sdk})),
      reply: async (input: unknown) => sendDecision.output.parse(
        await handlers.get(sendDecision.name)!(sendDecision.input.parse(input), {paseo: sdk})),
    };
  }

  return { sdk, prefs, notes, workspaces, agents, timelines, issueStates, commitStates, tool, run, board, sent };
}

function sessionTools(f: Awaited<ReturnType<typeof openIssueBoard>>, sessionId: string) {
  return {
    read: async () => JSON.parse(await f.run("read_board_conversation", {sessionId})),
    classify: (input: Record<string, unknown>) => f.run("classify_board_conversation", {sessionId, ...input}),
    append: (...turns: (string | {role: "user"; text: string})[]) => {
      f.timelines.get(sessionId)!.push(...turns);
      const agent = f.agents.find(a => a.id === sessionId)!;
      agent.updatedAt = new Date(Date.parse(agent.updatedAt) + 1000).toISOString();
    },
  };
}

test("review carries the stage-two question through the board snapshot and reply RPC", async () => {
  const f = await openIssueBoard();
  const sessionId = "w305";
  const {read, classify, append} = sessionTools(f, sessionId);
  const board = f.board();
  const card = async () => projectCards(await board.snapshot()).human.find(c => c.session.id === sessionId);
  const opened = await read();
  const content = {question: "공식 안전문과 저작권 규칙을 알려 주세요.", needsInput: "공식 안전문 원문과 회사 저작권 규칙"};
  await classify({evidenceId: opened.evidenceId, kind: "question", text: "#305 2단계 자료 대기", content});
  const initial = (await card())!.session;
  const oldVersion = initial.decision!.version;
  const updatedContent = {...content, recommendation: "공식 원문과 회사명 표기 규칙을 첨부합니다."};
  await classify({evidenceId: opened.evidenceId, kind: "question", text: "#305 2단계 자료 대기", content: updatedContent});
  const currentVersion = (await card())!.session.decision!.version;
  expect(currentVersion).not.toBe(oldVersion);
  append("#305 1단계 통합 확인을 기다립니다.");
  const latest = await read();
  await classify({evidenceId: latest.evidenceId, kind: "review", text: "#305 1단계 통합 확인"});

  const carried = (await card())?.session;
  expect(carried).toMatchObject({lane: "human", evidenceId: latest.evidenceId,
    decision: {...updatedContent, version: currentVersion, source: "coordinator"}});
  expect(sessionClarificationCard(carried!)).toEqual({
    kind: "session", sessionId, projectId: "easydocs", version: currentVersion,
  });
  const answer = {projectId: "easydocs", sessionId, recipientId: sessionId, action: "reply",
    text: "첨부 원문과 회사명 표기 규칙을 사용하세요.", requestKey: "carried-question-reply"};
  await expect(board.reply({...answer, version: oldVersion})).rejects.toThrow(/바뀌었습니다/);
  await expect(board.reply({...answer, version: carried!.decision!.version})).resolves.toMatchObject({recipientId: sessionId});
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].id).toBe(sessionId);
  expect(JSON.parse(f.sent[0].text.split("\n")[1])).toMatchObject({
    sourceSessionId: sessionId, recipientSessionId: sessionId, evidenceId: opened.evidenceId,
    revision: carried!.decision!.version, questions: [{id: carried!.decision!.version, text: content.question}],
  });
});

test.each(["single question", "older question carried"])("progress updates preserve the current decision and reply: %s", async scenario => {
  const f = await openIssueBoard();
  const sessionId = "w305";
  const {read, classify, append} = sessionTools(f, sessionId);
  const board = f.board();
  const card = async () => projectCards(await board.snapshot()).human.find(c => c.session.id === sessionId);
  let older: {evidenceId: string; version: string} | undefined;
  if (scenario === "older question carried") {
    const {evidenceId} = await read();
    await classify({evidenceId, kind: "question", text: "원문 보존 기간을 알려 주세요."});
    older = {evidenceId, version: (await card())!.session.decision!.version};
    append("표지 이미지 경로를 알려 주세요.");
  }
  const {evidenceId} = await read();
  const content = older
    ? {question: "표지 이미지 경로를 알려 주세요.", needsInput: "표지 이미지 파일 경로"}
    : {question: "공식 안전문과 저작권 규칙을 알려 주세요.", needsInput: "공식 안전문 원문과 회사 저작권 규칙"};
  await classify({evidenceId, kind: "question", text: content.question, content});
  const version = (await card())!.session.decision!.version;

  append("1단계 검증 자료를 정리했습니다.");
  const progress = await read();
  expect(progress.evidenceId).not.toBe(evidenceId);
  expect((await card())?.session).toMatchObject({evidenceId: progress.evidenceId,
    decision: {...content, evidenceId, version, source: "coordinator"}});

  const reworded = older ? "표지에 넣을 파일의 위치를 알려 주실 수 있나요?" : "공식 안전 문구 원본과 저작권 표기 기준을 알려 주실 수 있나요?";
  for (const update of [
    content.question,
    `${content.question}\n1단계 검증 자료는 정리했습니다.`,
    reworded,
    "상태 공유입니다. 요청할 결정은 없습니다.",
  ]) {
    append(update);
    expect((await card())?.session.decision).toMatchObject({...content, version, evidenceId, source: "coordinator"});
  }

  append(reworded);
  expect(decisionSummary((await card())!, text => text).evidence.join("\n")).toContain(reworded);
  const answer = {projectId: "easydocs", sessionId, recipientId: sessionId, action: "reply",
    text: "첨부한 자료를 사용하세요.", requestKey: "reply-after-progress", version};
  const worker = f.agents.find(a => a.id === sessionId)!;
  worker.pendingPermissions.push({id: "fixture-permission"});
  expect((await card())?.session.decision).toMatchObject({source: "permission"});
  await expect(board.reply(answer)).rejects.toThrow(/보낼 수 없습니다/);
  worker.pendingPermissions.length = 0;

  if (older) await expect(board.reply({...answer, version: older.version})).rejects.toThrow(/바뀌었습니다/);
  await expect(board.reply(answer)).resolves.toMatchObject({recipientId: sessionId});
  expect(f.sent).toHaveLength(1);
  expect(JSON.parse(f.sent[0].text.split("\n")[1])).toMatchObject({evidenceId, revision: version,
    recipientSessionId: sessionId, questions: [{id: version, text: content.question}]});
  expect(await card()).toBeUndefined();

  append({role: "user", text: older ? "표지는 cover.png이고 원문은 14일간 보존하세요." : "첨부 원문과 회사명 표기 규칙을 사용하세요."},
    "요청한 자료를 확인했습니다.");
  const resolved = await read();
  const replyId = resolved.userReplies.at(-1).replyId;
  const questionAnswer = [{questionEvidenceId: evidenceId, replyId}];
  if (older) questionAnswer.push({questionEvidenceId: older.evidenceId, replyId});
  await classify({evidenceId: resolved.evidenceId, kind: "idle", text: "남은 결정 없음", questionAnswer});
  expect(await card()).toBeUndefined();
  expect(f.prefs.read().judgments[sessionId]).toMatchObject({kind: "idle", evidenceId: resolved.evidenceId});
});

test("a distinct inferred question is visible before classification and gains its own reply version when registered", async () => {
  const f = await openIssueBoard();
  const sessionId = "w305";
  const {read, classify, append} = sessionTools(f, sessionId);
  const board = f.board();
  const card = async () => projectCards(await board.snapshot()).human.find(c => c.session.id === sessionId);
  const question = "공식 원문을 알려 주실 수 있나요?";
  append(question);
  expect((await card())?.session.decision).toMatchObject({source: "conversation", question});
  const original = await read();
  const content = {question, needsInput: "공식 원문"};
  await classify({evidenceId: original.evidenceId, kind: "question", text: question, content});
  const originalVersion = (await card())!.session.decision!.version;

  const distinct = "어느 표기 형식을 선택하시겠어요?";
  append(distinct);
  const detected = (await card())!;
  expect(detected.session.decision).toMatchObject({...content, version: originalVersion});
  expect(decisionSummary(detected, text => text).evidence.join("\n")).toContain(distinct);
  const latest = await read();
  await classify({evidenceId: latest.evidenceId, kind: "question", text: distinct, content: {question: distinct}});
  const newDecision = (await card())!.session.decision!;
  expect(newDecision).toMatchObject({source: "coordinator", question: distinct});
  expect(newDecision.version).not.toBe(originalVersion);
  expect(f.prefs.read().judgments[sessionId].openQuestions).toMatchObject([{evidenceId: original.evidenceId, content}]);

  const answer = {projectId: "easydocs", sessionId, recipientId: sessionId, action: "reply",
    text: "두 번째 표기 형식을 선택합니다.", requestKey: "reply-to-distinct-question"};
  await expect(board.reply({...answer, version: originalVersion})).rejects.toThrow(/바뀌었습니다/);
  await expect(board.reply({...answer, version: newDecision.version})).resolves.toMatchObject({recipientId: sessionId});
  expect(JSON.parse(f.sent[0].text.split("\n")[1])).toMatchObject({evidenceId: latest.evidenceId,
    revision: newDecision.version, questions: [{id: newDecision.version, text: distinct}]});

  append({role: "user", text: answer.text}, "표기 형식을 기록했습니다.");
  const reviewed = await read();
  await classify({evidenceId: reviewed.evidenceId, kind: "review", text: "#305 1단계 검증 확인",
    questionAnswer: {questionEvidenceId: latest.evidenceId, replyId: reviewed.userReplies.at(-1).replyId}});
  expect((await card())?.session.decision).toMatchObject({...content, version: originalVersion, evidenceId: original.evidenceId});
});

test("same excerpt permits supplementing needsInput while rejecting a replacement question", async () => {
  const f = await openIssueBoard();
  const {read, classify} = sessionTools(f, "w305");
  const {evidenceId} = await read();
  const question = "공식 안전문을 보내 주실 수 있나요?";
  const input = {evidenceId, kind: "question", text: "#305 공식 안전문 대기"};
  await classify({...input, content: {question}});
  const needsInput = "공식 CE/UL 안전문 원문";
  await classify({...input, content: {question, needsInput}});
  const supplemented = f.prefs.read().judgments.w305;
  expect(supplemented.content).toEqual({question, needsInput});
  await classify({evidenceId, kind: "review", text: "#305 1단계 통합 확인"});
  await expect(classify({...input, content: {question: "배포 날짜를 알려 주실 수 있나요?", needsInput}}))
    .rejects.toThrow(/다른 질문으로 교체/);
  await classify({...input, content: {question}});
  expect(f.prefs.read().judgments.w305.content).toEqual({question, needsInput});
});

test("question-specific withdrawal and replies can resolve separate open questions", async () => {
  const f = await openIssueBoard();
  const {read, classify, append} = sessionTools(f, "w305");
  const ask = async (question: string) => {
    const {evidenceId} = await read();
    await classify({evidenceId, kind: "question", text: question, content: {question}});
    return evidenceId;
  };
  const h1 = await ask("H1 사진 검토 요청");
  append("원문 보존 기간을 알려 주세요.");
  const retention = await ask("원문 보존 기간");
  append("표지 이미지 경로를 알려 주세요.");
  const cover = await ask("표지 이미지 경로");
  append({role: "user", text: "원문은 14일 보존하세요."}, "H1 사진 검토 요청이 취소됐습니다. 원문 보존 기간을 기록했습니다.");
  const partial = await read();
  const receipt = {kind: "withdrawn", targetEvidenceId: h1, reason: "H1 사진 검토 취소"};
  const retentionAnswer = {questionEvidenceId: retention, replyId: partial.userReplies.at(-1).replyId};
  const finish = (evidenceId: string, questionAnswer: unknown) =>
    classify({evidenceId, kind: "idle", text: "남은 결정 없음", receipt, questionAnswer});
  const before = f.prefs.read().judgments.w305;
  await expect(finish(partial.evidenceId, retentionAnswer)).rejects.toThrow(/질문/);
  expect(f.prefs.read().judgments.w305).toEqual(before);
  append({role: "user", text: "표지 이미지는 cover.png를 사용하세요."},
    "H1 사진 검토 요청이 취소됐습니다. 원문 보존 기간과 표지 이미지 경로를 기록했습니다.");
  const done = await read();
  const coverAnswer = {questionEvidenceId: cover, replyId: done.userReplies.at(-1).replyId};
  await expect(classify({evidenceId: done.evidenceId, kind: "idle", text: "남은 결정 없음",
    receipt: {...receipt, targetEvidenceId: cover}, questionAnswer: [retentionAnswer, coverAnswer]}))
    .rejects.toThrow(/철회·취소 근거/);
  expect(f.prefs.read().judgments.w305).toEqual(before);
  await finish(done.evidenceId, [retentionAnswer, coverAnswer]);
  expect(f.prefs.read().judgments.w305).toMatchObject({kind: "idle", receipt});
  expect(f.prefs.read().judgments.w305.openQuestions).toBeUndefined();
});

test("a review with one cited answer keeps the other question and its needsInput on the board", async () => {
  const f = await openIssueBoard();
  const sessionId = "w305";
  const {read, classify, append} = sessionTools(f, sessionId);
  const first = await read();
  const remaining = {question: "공식 안전문을 보내 주세요.", needsInput: "공식 CE/UL 원문"};
  await classify({evidenceId: first.evidenceId, kind: "question", text: remaining.question, content: remaining});
  append("보존 기간을 알려 주세요.");
  const second = await read();
  await classify({evidenceId: second.evidenceId, kind: "question", text: "보존 기간을 알려 주세요."});
  append({role: "user", text: "14일 보존하세요."}, "보존 기간을 기록했습니다.");
  const latest = await read();
  await classify({evidenceId: latest.evidenceId, kind: "review", text: "#305 1단계 통합 확인",
    questionAnswer: {questionEvidenceId: second.evidenceId, replyId: latest.userReplies.at(-1).replyId}});
  expect(f.prefs.read().judgments.w305.openQuestions?.map(q => q.evidenceId)).toEqual([first.evidenceId]);
  const card = projectCards(await f.board().snapshot()).human.find(c => c.session.id === sessionId);
  expect(card?.session.decision).toMatchObject({...remaining, evidenceId: first.evidenceId});
});

test.each(["unrelated", "rollover", "reported answer"] as const)("binds stage-two answers to their question: %s", async scenario => {
  const { run, timelines, sdk, notes, issueStates, commitStates } = await openIssueBoard();
  const sessionId = "w305";
  const history = timelines.get(sessionId)!;
  const question = "2단계 원문과 저작권 규칙을 제공해 주세요.";
  history.unshift({role: "user", text: "예전 요청"}, {role: "user", text: "예전 원문"});
  while (history.length < 48) history.push("자료 조사 중");
  const read = async () => JSON.parse(await run("read_board_conversation", { sessionId }));
  const opened = await read();
  if (scenario === "reported answer") {
    let hook: any;
    attachReportTool({addHook: (_: string, fn: unknown) => { hook = fn; }} as any, notes);
    const metadata = {[reportingKey]: true};
    const { tools } = await hook({request:{purpose:"interactive", metadata, tools:[]}});
    const handle = {...sdk.agents.ref(sessionId), refresh: async () => {}, metadata};
    await tools[0].execute({kind:"question", text:question}, {agent:{id:sessionId}, paseo:{agents:{ref:() => handle}}});
    history.push({role: "user", text: "원문은 첨부본을 쓰고 저작권은 회사명으로 표기하세요."}, "자료를 확인했습니다.");
  } else {
    await run("classify_board_conversation", { sessionId, evidenceId: opened.evidenceId, kind: "question",
      text: question, content: {question, needsInput: "원문과 저작권 규칙"} });
    if (scenario === "unrelated") history.push({role: "user", text: "1단계 통합 결과만 알려 주세요."});
  }
  history.push("#305 1단계 305aaaa 원격 main 통합과 CI 통과를 확인했습니다.");
  issueStates.set("acme/easydocs#305", {state:"CLOSED", stateReason:"COMPLETED",
    closing:{status:"commit", sha:"305aaaa".padEnd(40, "0")}});
  commitStates.set("acme/easydocs@305aaaa", {onMain:true, checks:"passed", resolvedSha:"305aaaa".padEnd(40,"0")});
  const latest = await read();
  const close = (questionAnswer?: {questionEvidenceId: string; replyId: string}) => run("classify_board_conversation", {
    sessionId, evidenceId: latest.evidenceId, kind: "idle", text: "#305 완료", questionAnswer,
    receipt: {kind:"completed", repo:"acme/easydocs", issue:305, commit:"305aaaa", verifiedCommit:"305aaaa",
      verification:{source:"ci", status:"passed", summary:"CI passed"}, closeReason:"COMPLETED"} });
  if (scenario === "reported answer") {
    const replyId = latest.userReplies.at(-1).replyId;
    await expect(close({questionEvidenceId: "different-question", replyId})).rejects.toThrow(/사용자 답변/);
    await close({questionEvidenceId: opened.evidenceId, replyId});
  } else {
    await expect(close()).rejects.toThrow(/사용자 답변/);
    if (scenario === "rollover") {
      const oldReply = latest.userReplies.at(-1);
      expect(oldReply.text).toBe("예전 원문");
      await expect(close({questionEvidenceId: opened.evidenceId, replyId: oldReply.replyId})).rejects.toThrow(/사용자 답변/);
    }
  }
});

test("general answers clear only the cited question, including when two sources share an excerpt", async () => {
  const replyId = "epoch:4";
  const evidence = {id: "latest", turns: [{role:"assistant" as const, text:"보존 기간을 기록했습니다."}],
    userReplies:[{role:"user" as const, text:"14일 보관하세요.", replyId}]};
  const note = {activeNoteKind:"question" as const, activeNoteEvidenceId:"opened", activeNoteCursor:"epoch:2",
    activeNoteRevision:1, activeNoteText:"보존 기간을 알려 주세요.", hasActiveAgentNote:true, isClarificationReply:false};
  const answer = {questionEvidenceId:"opened", replyId, noteRevision:1};
  const verify = (context: typeof note & {previousOpenQuestions?: {evidenceId:string; cursor:string; text:string}[]}) =>
    verifyIdleClassification(evidence, {text:"자료 확인", questionAnswer:answer}, context, {} as OutcomeVerifier);
  expect(await verify(note)).toBeNull();
  const withdrawal = {...evidence, turns:[{role:"assistant" as const, text:"보존 기간 요청이 취소됐습니다."}]};
  expect(await verifyIdleClassification(withdrawal, {text:"자료 확인", questionAnswer:{questionEvidenceId:"fake", replyId:"fake"}},
    note, {} as OutcomeVerifier)).toMatch(/withdrawn/);
  expect(await verify({...note, previousOpenQuestions:[{evidenceId:"opened", cursor:"epoch:2", text:"원문과 저작권 규칙"}]})).toMatch(/질문/);
});

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
  const { prefs, notes, agents, timelines, issueStates, commitStates, tool, run } = await openIssueBoard();
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
    receipt: { kind: "withdrawn", targetEvidenceId: initialExcerpt.evidenceId, reason: "임의 취소" },
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

  // Close issue #308 as COMPLETED (with closingCommit cf6f661), but commit cf6f661 is still only on a feature branch (onMain: false) -> rejected.
  issueStates.set("acme/easydocs#308", {
    state: "CLOSED",
    stateReason: "COMPLETED",
    closingCommits: ["cf6f661000000000000000000000000000000000"],
  });
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

  // 3. Worker finishes /done with integration commit cf6f661 + repro log SHA e9fe346 in same sentence + cleanup hold + unrelated doc task waiting!
  w308.updatedAt = "2026-11-26T06:36:00Z";
  timelines.get("w308")!.push("최종검증 대기입니다. 재현 로그는 e9fe346을 기준으로 확보했습니다.");
  const reproLogOnlyExcerpt = JSON.parse(await run("read_board_conversation", { sessionId: "w308" }));
  commitStates.set("acme/easydocs@e9fe346", { onMain: true, resolvedSha: "e9fe346000000000000000000000000000000000", checks: "passed" });
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: reproLogOnlyExcerpt.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: { ...baseReceipt, commit: "e9fe346", verifiedCommit: "e9fe346" },
  })).rejects.toThrow(/종료 커밋과 일치하지 않아/);

  w308.updatedAt = "2026-11-26T06:37:05Z";
  timelines.get("w308")!.push(
    "#308 마무리 점검과 정리 인계를 완료했습니다. 실제 통합 커밋은 cf6f661이고 재현 로그는 e9fe346에서 확보했습니다. CI 통과와 GitHub #308 COMPLETED 종료를 확인했지만 현재 작업 폴더는 사용 종료를 확인하지 못해 정리를 보류합니다. 별도 문서 작업은 자료를 기다립니다.",
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
    receipt: baseReceipt,
  })).rejects.toThrow(/검증 상태가 failed/);

  commitStates.set("acme/easydocs@cf6f661", { onMain: true, resolvedSha: "cf6f661000000000000000000000000000000000", checks: "unavailable" });
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: latestExcerpt.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: baseReceipt,
  })).rejects.toThrow(/통과된 GitHub 체크를 확인할 수 없어/);
  // Unauthenticated local verification claims are rejected by schema/verification fail-closed (no hand-written workspace JSON bypass)!
  expect(() => tool("classify_board_conversation").input.parse({
    sessionId: "w308",
    evidenceId: latestExcerpt.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: { ...baseReceipt, verification: { source: "local", status: "passed", summary: "로컬 통과" } },
  })).toThrow();

  commitStates.set("acme/easydocs@cf6f661", { onMain: true, resolvedSha: "cf6f661000000000000000000000000000000000", checks: "passed" });
  commitStates.set("acme/easydocs@e9fe346", { onMain: true, resolvedSha: "e9fe346000000000000000000000000000000000", checks: "passed" });
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: latestExcerpt.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: { ...baseReceipt, commit: "e9fe346", verifiedCommit: "e9fe346" },
  })).rejects.toThrow(/종료 커밋과 일치하지 않아/);
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
  const { prefs, agents, timelines, issueStates, commitStates, run } = await openIssueBoard();
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
    receipt: { kind: "withdrawn", targetEvidenceId: e305.evidenceId, reason: "임의 철회" },
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
    receipt: { kind: "withdrawn", targetEvidenceId: e305.evidenceId, reason: "임의 철회" },
  })).rejects.toThrow(/철회·취소 근거/);

  // A valid stage-1 `completed` receipt MUST NOT close #305's open stage-2 human question while the latest excerpt still says stage-2 inputs are needed!
  issueStates.set("acme/easydocs#305", {
    state: "CLOSED",
    stateReason: "COMPLETED",
    closing: { status: "commit", sha: "305aaaa000000000000000000000000000000000" },
  });
  commitStates.set("acme/easydocs@305aaaa", {
    onMain: true,
    resolvedSha: "305aaaa000000000000000000000000000000000",
    checks: "passed",
  });
  w305.updatedAt = "2026-11-26T06:36:00Z";
  timelines.get("w305")!.push("#305 1단계 통합 커밋 305aaaa를 원격 main에 반영했습니다. 다만 2단계 공식 CE/UL 원문과 저작권 규칙은 여전히 필요합니다.");
  const stage1Done305 = JSON.parse(await run("read_board_conversation", { sessionId: "w305" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w305",
    evidenceId: stage1Done305.evidenceId,
    kind: "idle",
    text: "#305 1단계 완료",
    receipt: {
      kind: "completed",
      repo: "acme/easydocs",
      issue: 305,
      commit: "305aaaa",
      verifiedCommit: "305aaaa",
      verification: { source: "ci", status: "passed", summary: "CI passed" },
      closeReason: "COMPLETED",
    },
  })).rejects.toThrow(/사용자 입력·결정 대기/);
  expect(prefs.read().judgments.w305).toMatchObject({
    kind: "question",
    content: { needsInput: expect.stringContaining("저작권") },
  });

  // Even when a new assistant-only turn mentions ONLY Stage-1 completion (without repeating the Stage-2 question), or uses "별도로 2단계 진행에는 ... 여전히 필요합니다", or tries `question -> review -> completed`, #305's unanswered Stage-2 question MUST remain open!
  w305.updatedAt = "2026-11-26T06:36:15Z";
  timelines.get("w305")!.push("#305 1단계 통합 커밋 305aaaa를 원격 main에 반영했고 CI 통과와 GitHub COMPLETED 종료를 확인했습니다.");
  const stage1Silent305 = JSON.parse(await run("read_board_conversation", { sessionId: "w305" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w305",
    evidenceId: stage1Silent305.evidenceId,
    kind: "idle",
    text: "#305 1단계 완료",
    receipt: {
      kind: "completed",
      repo: "acme/easydocs",
      issue: 305,
      commit: "305aaaa",
      verifiedCommit: "305aaaa",
      verification: { source: "ci", status: "passed", summary: "CI passed" },
      closeReason: "COMPLETED",
    },
  })).rejects.toThrow(/열린 질문\(question\)에 대한 사용자 답변 또는 질문 철회 근거/);

  w305.updatedAt = "2026-11-26T06:36:30Z";
  timelines.get("w305")!.push("#305 1단계 통합 커밋 305aaaa 원격 main 반영 완료. 별도로 2단계 진행에는 사용자 원문과 저작권 규칙이 여전히 필요합니다.");
  const stage1Aside305 = JSON.parse(await run("read_board_conversation", { sessionId: "w305" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w305",
    evidenceId: stage1Aside305.evidenceId,
    kind: "idle",
    text: "#305 1단계 완료",
    receipt: {
      kind: "completed",
      repo: "acme/easydocs",
      issue: 305,
      commit: "305aaaa",
      verifiedCommit: "305aaaa",
      verification: { source: "ci", status: "passed", summary: "CI passed" },
      closeReason: "COMPLETED",
    },
  })).rejects.toThrow(/사용자 입력·결정 대기/);
  expect(prefs.read().judgments.w305).toMatchObject({
    kind: "question",
    content: { needsInput: expect.stringContaining("저작권") },
  });

  // Switching `question -> review` MUST preserve `openQuestion` so `question -> review -> completed -> idle` cannot silently drop an unanswered question either!
  await run("classify_board_conversation", {
    sessionId: "w305",
    evidenceId: stage1Aside305.evidenceId,
    kind: "review",
    text: "#305 1단계 통합 확인",
  });
  expect(prefs.read().judgments.w305.openQuestions).toMatchObject([{ evidenceId: e305.evidenceId }]);
  await expect(run("classify_board_conversation", {
    sessionId: "w305",
    evidenceId: stage1Aside305.evidenceId,
    kind: "idle",
    text: "#305 1단계 완료",
    receipt: {
      kind: "completed",
      repo: "acme/easydocs",
      issue: 305,
      commit: "305aaaa",
      verifiedCommit: "305aaaa",
      verification: { source: "ci", status: "passed", summary: "CI passed" },
      closeReason: "COMPLETED",
    },
  })).rejects.toThrow(/사용자 입력·결정 대기|열린 질문/);
  await run("classify_board_conversation", {
    sessionId: "w305", evidenceId: stage1Aside305.evidenceId, kind: "question", text: "정리 폴더 보존 기간",
    content: {question: "정리 폴더를 며칠 보존할까요?", needsInput: "보존 기간"},
  });
  expect(prefs.read().judgments.w305.openQuestions?.map(q => q.evidenceId)).toContain(e305.evidenceId);
  // Even on a silent assistant-only follow-up after `question -> review`, `openQuestion` STILL blocks `completed -> idle`!
  w305.updatedAt = "2026-11-26T06:36:40Z";
  timelines.get("w305")!.push("#305 305aaaa 원격 main 통합과 CI 통과를 마쳤습니다.");
  const stage1AfterReview305 = JSON.parse(await run("read_board_conversation", { sessionId: "w305" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w305",
    evidenceId: stage1AfterReview305.evidenceId,
    kind: "idle",
    text: "#305 완료",
    receipt: {
      kind: "completed",
      repo: "acme/easydocs",
      issue: 305,
      commit: "305aaaa",
      verifiedCommit: "305aaaa",
      verification: { source: "ci", status: "passed", summary: "CI passed" },
      closeReason: "COMPLETED",
    },
  })).rejects.toThrow(/열린 질문\(question\)에 대한 사용자 답변 또는 질문 철회 근거/);
  // Restore w305 judgment back to the original open question for withdrawal checks below.
  prefs.change(scope => {
    scope.judgments.w305 = {
      projectId: "easydocs",
      evidenceId: e305.evidenceId,
      kind: "question",

      text: "#305 2단계 공식 자료·저작권 규칙 대기",
      content: {
        question: "#305 2단계 진행을 위해 공식 CE/UL 안전문 원문, 표지 이미지, 저작권 치환 규칙을 제공해 주실 수 있나요?",
        needsInput: "공식 CE/UL 안전문 원문·표지 이미지·회사 저작권 치환 규칙",
      },
    };
  });

  // Checking whether the user withdrew ("철회 여부를 확인 중입니다") is also rejected fail-closed!
  w305.updatedAt = "2026-11-26T06:37:00Z";
  timelines.get("w305")!.push("사용자 요청 철회 여부를 확인 중입니다.");
  const checkingWithdraw305 = JSON.parse(await run("read_board_conversation", { sessionId: "w305" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w305",
    evidenceId: checkingWithdraw305.evidenceId,
    kind: "idle",
    text: "#305 철회",
    receipt: { kind: "withdrawn", targetEvidenceId: e305.evidenceId, reason: "임의 철회" },
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
    receipt: { kind: "withdrawn", targetEvidenceId: e305.evidenceId, reason: "임의 철회" },
  })).rejects.toThrow(/철회·취소 근거/);

  // Withdrawing a DIFFERENT request sharing two tokens ("2단계 공식 배포 요청이 취소됐습니다") is still rejected!
  w305.updatedAt = "2026-11-26T06:39:00Z";
  timelines.get("w305")!.push("#305 2단계 공식 배포 요청이 취소됐습니다.");
  const otherRequestWithdraw305 = JSON.parse(await run("read_board_conversation", { sessionId: "w305" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w305",
    evidenceId: otherRequestWithdraw305.evidenceId,
    kind: "idle",
    text: "#305 철회",
    receipt: { kind: "withdrawn", targetEvidenceId: e305.evidenceId, reason: "배포 취소" },
  })).rejects.toThrow(/철회·취소 근거/);

  // When the user withdraws the #305 stage-2 request, idle classification requires targetEvidenceId matching the open question (and no integration commit)!
  w305.updatedAt = "2026-11-26T06:40:00Z";
  timelines.get("w305")!.push("사용자 요청 철회를 확인했습니다. 2단계 자료 대기 없이 대기합니다.");
  const withdrawn305 = JSON.parse(await run("read_board_conversation", { sessionId: "w305" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w305",
    evidenceId: withdrawn305.evidenceId,
    kind: "idle",
    text: "#305 사용자 요청 철회 확인, 남은 결정 없음.",
    receipt: { kind: "withdrawn", targetEvidenceId: "wrong-evidence-id", reason: "사용자 요청 철회" },
  })).rejects.toThrow(/targetEvidenceId/);
  await run("classify_board_conversation", {
    sessionId: "w305",
    evidenceId: withdrawn305.evidenceId,
    kind: "idle",
    text: "#305 사용자 요청 철회 확인, 남은 결정 없음.",
    receipt: { kind: "withdrawn", targetEvidenceId: e305.evidenceId, reason: "사용자 요청 철회" },
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
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/issues/308/timeline?per_page=100&page=1") {
      // Closed by e9fe346 -> reopened -> closed by cf6f661: ONLY the final closing commit cf6f661 is valid!
      return JSON.stringify([
        {
          event: "closed",
          commit_id: "e9fe346000000000000000000000000000000000",
          commit_url: "https://api.github.com/repos/acme/easydocs/commits/e9fe346000000000000000000000000000000000",
        },
        { event: "reopened", commit_id: null, commit_url: null },
        {
          event: "closed",
          commit_id: "cf6f661000000000000000000000000000000000",
          commit_url: "https://api.github.com/repos/acme/easydocs/commits/cf6f661000000000000000000000000000000000",
        },
      ]);
    }
    if (cmd === "gh" && args[0] === "issue" && args[2] === "310") {
      return JSON.stringify({ state: "CLOSED", stateReason: "COMPLETED", url: "https://github.com/acme/EasyDocs/issues/310" });
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/issues/310/timeline?per_page=100&page=1") {
      throw new Error("timeline API error");
    }
    if (cmd === "gh" && args[0] === "issue" && args[2] === "311") {
      return JSON.stringify({ state: "CLOSED", stateReason: "COMPLETED", url: "https://github.com/acme/EasyDocs/issues/311" });
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/issues/311/timeline?per_page=100&page=1") {
      return JSON.stringify([
        {
          event: "closed",
          commit_id: "e9fe346000000000000000000000000000000000",
          commit_url: "https://api.github.com/repos/other/easydocs/commits/e9fe346000000000000000000000000000000000",
        },
      ]);
    }
    if (cmd === "gh" && args[0] === "issue" && args[2] === "312") {
      return JSON.stringify({ state: "CLOSED", stateReason: "COMPLETED", url: "https://github.com/acme/EasyDocs/issues/312" });
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/issues/312/timeline?per_page=100&page=1") {
      return JSON.stringify([{ event: "closed", commit_id: null, commit_url: null }]);
    }
    if (cmd === "gh" && args[0] === "issue" && args[2] === "313") {
      return JSON.stringify({ state: "CLOSED", stateReason: "COMPLETED", url: "https://github.com/acme/EasyDocs/issues/313" });
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/issues/313/timeline?per_page=100&page=1") {
      // Missing commit_id field -> MUST fail closed as unavailable (not manual)!
      return JSON.stringify([{ event: "closed" }]);
    }
    if (cmd === "gh" && args[0] === "issue" && args[2] === "314") {
      return JSON.stringify({ state: "CLOSED", stateReason: "COMPLETED", url: "https://github.com/acme/EasyDocs/issues/314" });
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/issues/314/timeline?per_page=100&page=1") {
      // Contradictory commit_id (e9fe346) vs commit_url (cf6f661) -> MUST fail closed as unavailable!
      return JSON.stringify([
        {
          event: "closed",
          commit_id: "e9fe346000000000000000000000000000000000",
          commit_url: "https://api.github.com/repos/acme/easydocs/commits/cf6f661000000000000000000000000000000000",
        },
      ]);
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/commits/f00ba40") {
      return JSON.stringify({
        sha: "f00ba40000000000000000000000000000000000",
        commit: { message: "Update README. Does not fix #308. Docs sync from PR acme/easydocs#308. Fixes other/easydocs#308" },
      });
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/commits/f00ba41") {
      return JSON.stringify({
        sha: "f00ba41000000000000000000000000000000000",
        commit: { message: "fix(photo): replace action\n\nCloses acme/easydocs#308" },
      });
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/compare/main...f00ba41000000000000000000000000000000000") {
      return "behind\n";
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/commits/f00ba41000000000000000000000000000000000/check-runs?per_page=100&page=1") {
      return JSON.stringify({ total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] });
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/commits/f00ba41000000000000000000000000000000000/status?per_page=100&page=1") {
      return JSON.stringify({ state: "success", total_count: 0, statuses: [] });
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/compare/main...f00ba40000000000000000000000000000000000") {
      return "behind\n";
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/commits/f00ba40000000000000000000000000000000000/check-runs?per_page=100&page=1") {
      return JSON.stringify({ total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] });
    }
    if (cmd === "gh" && args[1] === "repos/acme/easydocs/commits/f00ba40000000000000000000000000000000000/status?per_page=100&page=1") {
      return JSON.stringify({ state: "success", total_count: 0, statuses: [] });
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
    closing: { status: "commit", sha: "cf6f661000000000000000000000000000000000" },
    closingCommits: ["cf6f661000000000000000000000000000000000"],
  });
  expect(await verifier.verifyIssue("acme/easydocs", 310)).toEqual({
    state: "CLOSED",
    stateReason: "COMPLETED",
    url: "https://github.com/acme/EasyDocs/issues/310",
    closing: { status: "unavailable" },
  });
  expect(await verifier.verifyIssue("acme/easydocs", 311)).toEqual({
    state: "CLOSED",
    stateReason: "COMPLETED",
    url: "https://github.com/acme/EasyDocs/issues/311",
    closing: { status: "foreign_commit" },
  });
  expect(await verifier.verifyIssue("acme/easydocs", 312)).toEqual({
    state: "CLOSED",
    stateReason: "COMPLETED",
    url: "https://github.com/acme/EasyDocs/issues/312",
    closing: { status: "manual" },
  });
  expect(await verifier.verifyIssue("acme/easydocs", 313)).toEqual({
    state: "CLOSED",
    stateReason: "COMPLETED",
    url: "https://github.com/acme/EasyDocs/issues/313",
    closing: { status: "unavailable" },
  });
  expect(await verifier.verifyIssue("acme/easydocs", 314)).toEqual({
    state: "CLOSED",
    stateReason: "COMPLETED",
    url: "https://github.com/acme/EasyDocs/issues/314",
    closing: { status: "unavailable" },
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
  issueStates.set("acme/easydocs#308", {
    state: "CLOSED",
    stateReason: "COMPLETED",
    closingCommits: ["cf6f661000000000000000000000000000000000"],
  });
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
  notes.update({ sessionId: "w308", kind: "clear", text: "", expectedRevision: 1 }, "person");

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
  // 6. Legacy scope.json containing a prior `withdrawn` receipt without targetEvidenceId remains readable by PreferenceStore.read()!
  const legacyDir = mkdtempSync(join(tmpdir(), "board-legacy-withdrawn-"));
  dirs.push(legacyDir);
  const legacyScopePath = join(legacyDir, "scope.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(legacyScopePath, JSON.stringify({
    projects: ["easydocs"],
    coordinator: "coord",
    judgments: {
      w305: {
        projectId: "easydocs",
        evidenceId: "legacy-ev",
        kind: "idle",
        text: "#305 철회",
        receipt: { kind: "withdrawn", reason: "이전 판본 철회" },
      },
    },
  }));
  const legacyPrefs = new PreferenceStore(legacyScopePath);
  expect(legacyPrefs.read().judgments.w305.receipt).toEqual({ kind: "withdrawn", reason: "이전 판본 철회" });

  // 7. Manual close without GitHub closing commit, timeline lookup failure ("unavailable"), and foreign closing commit MUST all fail closed!
  workspaces[1].gitRuntime.remoteUrl = "https://github.com/acme/EasyDocs.git";
  midVerifyAction = undefined;
  commitStates.set("acme/easydocs@cf6f661", {
    onMain: true,
    resolvedSha: "cf6f661000000000000000000000000000000000",
    checks: "passed",
  });
  for (const closing of [
    { status: "manual" as const },
    { status: "unavailable" as const },
    { status: "foreign_commit" as const },
  ]) {
    issueStates.set("acme/easydocs#308", { state: "CLOSED", stateReason: "COMPLETED", closing });
    await expect(run("classify_board_conversation", {
      sessionId: "w308",
      evidenceId: ev.evidenceId,
      kind: "idle",
      text: "#308 완료",
      receipt: validReceipt,
    })).rejects.toThrow(/최종 GitHub 종료 커밋을 확인할 수 없어/);
  }
  // When neither closing nor closingCommits is present, also fail closed!
  issueStates.set("acme/easydocs#308", { state: "CLOSED", stateReason: "COMPLETED" });
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: ev.evidenceId,
    kind: "idle",
    text: "#308 완료",
    receipt: validReceipt,
  })).rejects.toThrow(/종료 커밋 정보를 확인할 수 없어/);

  // 8. ANY prior `review` judgment on an issue-anchored session (regardless of wording like "최종 점검 결과 대조 필요" and even without an active agent-note) MUST reject receipt-less `idle`, `withdrawn`, downgrade to `general`, AND intermediate `question -> withdrawn -> idle` bypass!
  await run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: ev.evidenceId,
    kind: "review",
    text: "최종 점검 결과 대조 필요",
  });
  expect(prefs.read().judgments.w308).toMatchObject({
    kind: "review",
    reviewKind: "verification",
    verificationPending: true,
  });
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: ev.evidenceId,
    kind: "review",
    reviewKind: "general",
    text: "일반 검토로 낮춤",
  })).rejects.toThrow(/일반 검토\(reviewKind: 'general'\)로 낮출 수 없습니다/);
  w308.updatedAt = "2026-11-26T07:05:00Z";
  timelines.get("w308")!.push("#308 통합 결과의 검증 자료가 아직 도착하지 않았습니다.");
  const unverifiedReviewEv = JSON.parse(await run("read_board_conversation", { sessionId: "w308" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: unverifiedReviewEv.evidenceId,
    kind: "idle",
    text: "남은 일 없음",
  })).rejects.toThrow(/완료 영수증·검증 근거/);
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: unverifiedReviewEv.evidenceId,
    kind: "idle",
    text: "남은 일 없음",
    receipt: { kind: "withdrawn", targetEvidenceId: ev.evidenceId, reason: "검증 대기 철회" },
  })).rejects.toThrow(/미해결 통합·검증 대기/);
  expect(prefs.read().judgments.w308.kind).toBe("review");

  // 8b. Recording an intermediate `question` ("검증 일정 문의") MUST preserve `verificationPending: true` so cancelling that inquiry cannot clear the unresolved review wait!
  w308.updatedAt = "2026-11-26T07:06:00Z";
  timelines.get("w308")!.push("검증 일정은 언제로 잡을까요?");
  const inquiryEv = JSON.parse(await run("read_board_conversation", { sessionId: "w308" }));
  await run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: inquiryEv.evidenceId,
    kind: "question",
    text: "검증 일정 문의",
    content: { question: "검증 일정이 언제인가요?", needsInput: "검증 일정" },
  });
  expect(prefs.read().judgments.w308).toMatchObject({
    kind: "question",
    verificationPending: true,
  });
  w308.updatedAt = "2026-11-26T07:07:00Z";
  timelines.get("w308")!.push("검증 일정 문의는 취소됐습니다. 다만 검증 자료는 아직 도착하지 않았습니다.");
  const inquiryCancelEv = JSON.parse(await run("read_board_conversation", { sessionId: "w308" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: inquiryCancelEv.evidenceId,
    kind: "idle",
    text: "일정 문의 취소",
    receipt: { kind: "withdrawn", targetEvidenceId: inquiryEv.evidenceId, reason: "일정 문의 취소" },
  })).rejects.toThrow(/미해결 통합·검증 대기/);
  await expect(run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: inquiryCancelEv.evidenceId,
    kind: "idle",
    text: "남은 일 없음",
  })).rejects.toThrow(/완료 영수증·검증 근거/);
  expect(prefs.read().judgments.w308).toMatchObject({
    kind: "question",
    verificationPending: true,
  });

  // Once the user answers the schedule inquiry and #308 lands with a verified GitHub closing commit and passing CI (even when noting "추가 승인이 필요하지 않습니다"), `idle` succeeds and clears `verificationPending`!
  issueStates.set("acme/easydocs#308", {
    state: "CLOSED",
    stateReason: "COMPLETED",
    closing: { status: "commit", sha: "cf6f661000000000000000000000000000000000" },
  });
  w308.updatedAt = "2026-11-26T07:08:00Z";
  timelines.get("w308")!.push(
    { role: "user", text: "오늘 오후 3시에 검증 진행하세요." },
    "#308 cf6f661 원격 main 통합과 CI 통과를 마쳤습니다. 추가 승인이 필요하지 않습니다.",
  );
  const verifiedDoneEv = JSON.parse(await run("read_board_conversation", { sessionId: "w308" }));
  await run("classify_board_conversation", {
    sessionId: "w308",
    evidenceId: verifiedDoneEv.evidenceId,
    questionAnswer: {questionEvidenceId: inquiryEv.evidenceId, replyId: verifiedDoneEv.userReplies.at(-1).replyId},
    kind: "idle",
    text: "#308 cf6f661 원격 main 통합·CI 통과·GitHub COMPLETED 확인.",
    receipt: validReceipt,
  });
  expect(prefs.read().judgments.w308.kind).toBe("idle");
  expect(prefs.read().judgments.w308.verificationPending).toBeUndefined();

  // 9. Non-issue general review (e.g. meeting room booking time comparison) is classified `reviewKind: "general"` and clears to `idle` without requiring a GitHub receipt, while explicit `reviewKind: "verification"` still fails closed!
  const wMeeting = {
    id: "w_meeting",
    title: "회의실 예약 확인",
    status: "idle",
    projectId: "easydocs",
    workspaceId: "wks_office",
    updatedAt: "2026-11-26T07:10:00Z",
    pendingPermissions: [],
    labels: { coordinatorBoardParent: "coord" },
  };
  // Use a non-issue workspace for the meeting-room check so no `#308` anchor leaks from workspaceTitle.
  workspaces.push({
    id: "wks_office",
    projectId: "easydocs",
    title: "office-schedule",
    workspaceKind: "local_checkout",
    workspaceDirectory: "/work/office",
    gitRuntime: { currentBranch: "main", remoteUrl: "https://github.com/acme/EasyDocs.git" },
  });
  agents.push(wMeeting);
  timelines.set("w_meeting", ["회의실 A와 B의 14:00 예약 시간을 대조해 주세요."]);
  const meetingEv1 = JSON.parse(await run("read_board_conversation", { sessionId: "w_meeting" }));
  await run("classify_board_conversation", {
    sessionId: "w_meeting",
    evidenceId: meetingEv1.evidenceId,
    kind: "review",
    text: "회의실 예약 시간 대조 필요",
  });
  expect(prefs.read().judgments.w_meeting).toMatchObject({
    kind: "review",
    reviewKind: "general",
  });
  expect(prefs.read().judgments.w_meeting.verificationPending).toBeUndefined();
  wMeeting.updatedAt = "2026-11-26T07:11:00Z";
  timelines.get("w_meeting")!.push("회의실 예약 시간이 모두 일치하며 남은 일이 없습니다.");
  const meetingEv2 = JSON.parse(await run("read_board_conversation", { sessionId: "w_meeting" }));
  await run("classify_board_conversation", {
    sessionId: "w_meeting",
    evidenceId: meetingEv2.evidenceId,
    kind: "idle",
    text: "회의실 예약 시간 일치 확인, 남은 일 없음",
  });
  expect(prefs.read().judgments.w_meeting.kind).toBe("idle");

  // Explicit `reviewKind: "verification"` on a non-issue session still requires a receipt and persists across `question`!
  wMeeting.updatedAt = "2026-11-26T07:12:00Z";
  timelines.get("w_meeting")!.push("배포 전 결과 대조가 필요합니다.");
  const explicitVerifyEv = JSON.parse(await run("read_board_conversation", { sessionId: "w_meeting" }));
  await run("classify_board_conversation", {
    sessionId: "w_meeting",
    evidenceId: explicitVerifyEv.evidenceId,
    kind: "review",
    reviewKind: "verification",
    text: "최종 점검 결과 대조 필요",
  });
  expect(prefs.read().judgments.w_meeting).toMatchObject({
    kind: "review",
    reviewKind: "verification",
    verificationPending: true,
  });
  wMeeting.updatedAt = "2026-11-26T07:13:00Z";
  timelines.get("w_meeting")!.push("확인이 끝났고 남은 일이 없습니다.");
  const explicitVerifyEv2 = JSON.parse(await run("read_board_conversation", { sessionId: "w_meeting" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w_meeting",
    evidenceId: explicitVerifyEv2.evidenceId,
    kind: "idle",
    text: "남은 일 없음",
  })).rejects.toThrow(/완료 영수증·검증 근거/);

  // 10. A verification wait created on an untitled-issue session for `#308` MUST pin `verificationTarget: { repo, issues: [308] }` so a follow-up `#999` question and valid `#999` receipt CANNOT clear `#308`'s pending verification!
  const wUntitled = {
    id: "w_untitled",
    title: "통합 점검 세션",
    status: "idle",
    projectId: "easydocs",
    workspaceId: "wks_office",
    updatedAt: "2026-11-26T07:20:00Z",
    pendingPermissions: [],
    labels: { coordinatorBoardParent: "coord" },
  };
  agents.push(wUntitled);
  timelines.set("w_untitled", ["통합 결과 확인을 기다립니다."]);
  const untitledEv1 = JSON.parse(await run("read_board_conversation", { sessionId: "w_untitled" }));
  await run("classify_board_conversation", {
    sessionId: "w_untitled",
    evidenceId: untitledEv1.evidenceId,
    kind: "review",
    text: "#308 최종 검증 대기",
  });
  expect(prefs.read().judgments.w_untitled).toMatchObject({
    kind: "review",
    reviewKind: "verification",
    verificationPending: true,
    verificationTarget: { repo: "acme/easydocs", issues: [308] },
  });
  wUntitled.updatedAt = "2026-11-26T07:21:00Z";
  timelines.get("w_untitled")!.push("#999 일정 문의가 들어왔습니다.");
  const untitledEv2 = JSON.parse(await run("read_board_conversation", { sessionId: "w_untitled" }));
  await run("classify_board_conversation", {
    sessionId: "w_untitled",
    evidenceId: untitledEv2.evidenceId,
    kind: "question",
    text: "#999 일정 문의",
    content: { question: "#999 일정을 확인해 주세요", needsInput: "일정" },
  });
  expect(prefs.read().judgments.w_untitled).toMatchObject({
    kind: "question",
    verificationPending: true,
    verificationTarget: { repo: "acme/easydocs", issues: [308] },
  });
  // Even with a fully verified `#999` GitHub completion, `#999`'s receipt MUST NOT clear `#308`'s pending verification!
  issueStates.set("acme/easydocs#999", {
    state: "CLOSED",
    stateReason: "COMPLETED",
    closing: { status: "commit", sha: "999aaaa000000000000000000000000000000000" },
  });
  commitStates.set("acme/easydocs@999aaaa", {
    onMain: true,
    resolvedSha: "999aaaa000000000000000000000000000000000",
    checks: "passed",
  });
  wUntitled.updatedAt = "2026-11-26T07:22:00Z";
  timelines.get("w_untitled")!.push("#999 999aaaa 원격 main 통합 완료. 다만 #308 검증 자료는 아직 도착하지 않았습니다.");
  const untitledEv3 = JSON.parse(await run("read_board_conversation", { sessionId: "w_untitled" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w_untitled",
    evidenceId: untitledEv3.evidenceId,
    kind: "idle",
    text: "#999 완료",
    receipt: {
      kind: "completed",
      repo: "acme/easydocs",
      issue: 999,
      commit: "999aaaa",
      verifiedCommit: "999aaaa",
      verification: { source: "ci", status: "passed", summary: "CI passed" },
      closeReason: "COMPLETED",
    },
  })).rejects.toThrow(/미해결 검증 대기의 대상 이슈\(#308\)/);
  expect(prefs.read().judgments.w_untitled).toMatchObject({
    kind: "question",
    verificationPending: true,
    verificationTarget: { repo: "acme/easydocs", issues: [308] },
  });
  // Once the user replies to the #999 inquiry and a valid `#308` receipt arrives, `#308`'s pending verification clears!
  wUntitled.updatedAt = "2026-11-26T07:23:00Z";
  timelines.get("w_untitled")!.push(
    { role: "user", text: "#999 일정 확인 완료했습니다. #308 결과로 마무리하세요." },
    "#308 cf6f661 원격 main 통합과 CI 통과를 마쳤습니다. 추가 승인이 필요하지 않습니다.",
  );
  const untitledEv4 = JSON.parse(await run("read_board_conversation", { sessionId: "w_untitled" }));
  await run("classify_board_conversation", {
    sessionId: "w_untitled",
    evidenceId: untitledEv4.evidenceId,
    questionAnswer: {questionEvidenceId: untitledEv2.evidenceId, replyId: untitledEv4.userReplies.at(-1).replyId},
    kind: "idle",
    text: "#308 완료",
    receipt: validReceipt,
  });
  expect(prefs.read().judgments.w_untitled.kind).toBe("idle");
  expect(prefs.read().judgments.w_untitled.verificationPending).toBeUndefined();
  expect(prefs.read().judgments.w_untitled.verificationTarget).toBeUndefined();

  // 11. Multi-issue verification waits (`#308 및 #999`) MUST be rejected at `review` AND `question` creation time, AND legacy multi-issue `verificationTarget` MUST NOT be cleared by a single receipt!
  await expect(run("classify_board_conversation", {
    sessionId: "w_untitled",
    evidenceId: untitledEv4.evidenceId,
    kind: "review",
    text: "#308 및 #999 최종 검증 대기",
  })).rejects.toThrow(/세션당 하나의 이슈만 고정할 수 있습니다/);
  // Also reject creating a new multi-issue `verificationTarget` via `question` when an active agent-note reports multiple issues!
  const wMultiNote = {
    id: "w_multi_note",
    title: "복수 보고 세션",
    status: "idle",
    projectId: "easydocs",
    workspaceId: "wks_office",
    updatedAt: "2026-11-26T07:23:30Z",
    pendingPermissions: [],
    labels: { coordinatorBoardParent: "coord" },
  };
  agents.push(wMultiNote);
  timelines.set("w_multi_note", ["검증 일정 확인이 필요합니다."]);
  const multiNoteEv = JSON.parse(await run("read_board_conversation", { sessionId: "w_multi_note" }));
  expect(recordReport(notes, "w_multi_note", { kind: "review", text: "#308 및 #999 최종 검증 대기" }, multiNoteEv.evidenceId).isError).not.toBe(true);
  await expect(run("classify_board_conversation", {
    sessionId: "w_multi_note",
    evidenceId: multiNoteEv.evidenceId,
    kind: "question",
    text: "검증 일정 문의",
    content: { question: "검증 일정이 언제인가요?", needsInput: "일정" },
  })).rejects.toThrow(/세션당 하나의 이슈만 고정할 수 있습니다/);
  expect(prefs.read().judgments.w_multi_note).toBeUndefined();
  // Simulate a legacy stored judgment with two pinned issues `[308, 999]` and confirm single `#999` receipt cannot clear it!
  prefs.change(scope => {
    scope.judgments.w_untitled = {
      projectId: "easydocs",
      evidenceId: untitledEv4.evidenceId,
      kind: "review",
      reviewKind: "verification",
      verificationPending: true,
      verificationTarget: { repo: "acme/easydocs", issues: [308, 999] },
      text: "#308 및 #999 최종 검증 대기",
    };
  });
  wUntitled.updatedAt = "2026-11-26T07:24:00Z";
  timelines.get("w_untitled")!.push("#999 999aaaa 원격 main 통합 완료. #308은 아직 검증 대기입니다.");
  const multiEv = JSON.parse(await run("read_board_conversation", { sessionId: "w_untitled" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w_untitled",
    evidenceId: multiEv.evidenceId,
    kind: "idle",
    text: "#999 완료",
    receipt: {
      kind: "completed",
      repo: "acme/easydocs",
      issue: 999,
      commit: "999aaaa",
      verifiedCommit: "999aaaa",
      verification: { source: "ci", status: "passed", summary: "CI passed" },
      closeReason: "COMPLETED",
    },
  })).rejects.toThrow(/복수\(#308, #999\)로 묶여 있어/);

  // 12. Out-of-range issue number (`#2147483648`) MUST NOT corrupt `scope.json` so subsequent `PreferenceStore.read()` always succeeds!
  const wOverflow = {
    id: "w_overflow",
    title: "범위 확인 세션",
    status: "idle",
    projectId: "easydocs",
    workspaceId: "wks_office",
    updatedAt: "2026-11-26T07:25:00Z",
    pendingPermissions: [],
    labels: { coordinatorBoardParent: "coord" },
  };
  agents.push(wOverflow);
  timelines.set("w_overflow", ["결과 확인을 기다립니다."]);
  const overflowEv = JSON.parse(await run("read_board_conversation", { sessionId: "w_overflow" }));
  await run("classify_board_conversation", {
    sessionId: "w_overflow",
    evidenceId: overflowEv.evidenceId,
    kind: "review",
    text: "#2147483648 최종 검증 대기",
  });
  expect(prefs.read().judgments.w_overflow).toMatchObject({
    kind: "review",
    reviewKind: "verification",
    verificationPending: true,
    verificationTarget: { repo: "acme/easydocs", issues: [] },
  });
  // When `verificationTarget.issues` is empty (unanchored verification wait), a later turn mentioning `#999` + valid `#999` receipt MUST NOT clear it!
  wOverflow.updatedAt = "2026-11-26T07:26:00Z";
  timelines.get("w_overflow")!.push("별건 #999 작업을 논의했습니다.");
  wOverflow.updatedAt = "2026-11-26T07:27:00Z";
  timelines.get("w_overflow")!.push("#999 999aaaa 원격 main 통합 완료.");
  const overflowEv2 = JSON.parse(await run("read_board_conversation", { sessionId: "w_overflow" }));
  await expect(run("classify_board_conversation", {
    sessionId: "w_overflow",
    evidenceId: overflowEv2.evidenceId,
    kind: "idle",
    text: "#999 완료",
    receipt: {
      kind: "completed",
      repo: "acme/easydocs",
      issue: 999,
      commit: "999aaaa",
      verifiedCommit: "999aaaa",
      verification: { source: "ci", status: "passed", summary: "CI passed" },
      closeReason: "COMPLETED",
    },
  })).rejects.toThrow(/대상 이슈가 확정되지 않아/);
  expect(prefs.read().judgments.w_overflow).toMatchObject({
    kind: "review",
    verificationPending: true,
    verificationTarget: { repo: "acme/easydocs", issues: [] },
  });

  // 13. Conflicting `review` input (`#999 최종 검증 대기`) MUST NOT overwrite an active `#308` verification agent-note!
  const wConflict = {
    id: "w_conflict",
    title: "활성 보고 세션",
    status: "idle",
    projectId: "easydocs",
    workspaceId: "wks_office",
    updatedAt: "2026-11-26T07:30:00Z",
    pendingPermissions: [],
    labels: { coordinatorBoardParent: "coord" },
  };
  agents.push(wConflict);
  timelines.set("w_conflict", ["결과 확인을 기다립니다."]);
  const conflictEv = JSON.parse(await run("read_board_conversation", { sessionId: "w_conflict" }));
  expect(recordReport(notes, "w_conflict", { kind: "review", text: "#308 최종 검증 대기" }, conflictEv.evidenceId).isError).not.toBe(true);
  await expect(run("classify_board_conversation", {
    sessionId: "w_conflict",
    evidenceId: conflictEv.evidenceId,
    kind: "review",
    text: "#999 최종 검증 대기",
  })).rejects.toThrow(/기존 세션·활성 검증 보고의 대상 이슈\(#308\)와 충돌/);
  expect(prefs.read().judgments.w_conflict).toBeUndefined();
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
