import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachCoordinatorTools } from "../../server/coordinator";
import { ConversationReader } from "../../server/conversation";
import { buildCoordinatorSystemPrompt } from "../../server/lifecycle";
import { createOperations } from "../../server/operations";
import { PreferenceStore } from "../../server/preferences";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function openBoard() {
  const dir = mkdtempSync(join(tmpdir(), "board-status-"));
  dirs.push(dir);
  const prefs = new PreferenceStore(join(dir, "scope.json"));
  prefs.change(scope => { scope.projects = ["control", "work"]; scope.coordinator = "coord"; });
  const agents = ["coord", "A", "B"].map(id => ({
    id, title: id === "coord" ? "코디네이터" : "검토", status: "running",
    updatedAt: "2026-11-25T23:34:18Z", pendingPermissions: [] as { id: string }[],
  }));
  const messages = new Map<string, string>();
  const timelineReads: string[] = [];
  const page = entries => ({ entries, pageInfo: { hasMore: false, nextCursor: null } });
  const sdk = {
    workspaces: { list: async () => page([]) },
    agents: {
      list: async () => page(agents.map(agent => ({ agent, project: { projectKey: agent.id === "coord" ? "control" : "work" } }))),
      ref: id => ({ timeline: { refetch: async () => {
        timelineReads.push(id);
        const text = messages.get(id);
        return { epoch: "1", entries: text ? [{ seqEnd: 1, item: { type: "assistant_message", text } }] : [] };
      } } }),
    },
  };
  let onOpen;
  attachCoordinatorTools({ addHook(_, hook) { onOpen = hook; } }, prefs, new ConversationReader(), createOperations(prefs, dir).tools);
  const opened = await onOpen({ request: { purpose: "interactive", agentId: "coord", tools: [] } });
  const tool = name => opened.tools.find(t => t.name === name);
  const read = async (input = {}) => JSON.parse((await tool("read_board_conversation").execute(input, { paseo: sdk, agent: { id: "coord" } })).text);
  return { prefs, agents, messages, sdk, timelineReads, tool, read };
}

test("새 헌장과 기존 세션 운영 예시는 같은 턴의 관리 범위와 상세 조회를 요구한다", () => {
  const template = readFileSync(new URL("../../templates/coordinator-session.md", import.meta.url), "utf8");
  for (const instructions of [buildCoordinatorSystemPrompt("/dev/null"), template]) {
    expect(instructions).toMatch(/이번 (?:응답 )?턴|같은 (?:응답 )?턴/);
    expect(instructions).toContain("get_agent_status");
    expect(instructions).toContain("미확인");
    expect(instructions).toContain("이번 조회에서");
    expect(instructions).toMatch(/배정 영수증.*배정 사실/);
  }
});

test("다음 대화에 노출되는 조회 도구와 배정 도구가 상태 근거와 첫 턴 구독 범위를 설명한다", async () => {
  const { tool } = await openBoard();
  const read = tool("read_board_conversation").description;
  expect(read).toMatch(/same turn/i);
  expect(read).toContain("get_agent_status");
  expect(read).toContain("activityAt");
  expect(read).toContain("time of this lookup");
  expect(read).toContain('{"sessionId":');
  expect(read).toMatch(/top.level/i);
  expect(read).toMatch(/unknown|unconfirmed/i);
  const assign = tool("assign_board_worker").description;
  expect(assign).toMatch(/receipt/i);
  expect(assign).toMatch(/first.turn/i);
  expect(assign).toContain("read_board_conversation");
});

test("동명 작업자의 권한 요청은 목록에 드러나지 않고 A의 발췌는 B의 상태 전환과 분리된다", async () => {
  const { agents: [, a, b], messages, read, timelineReads } = await openBoard();
  const before = await read();
  expect(before.find(row => row.id === "A").status).toBe("running");
  a.status = "idle";
  a.updatedAt = "2026-11-25T23:43:59Z";
  messages.set("A", "검증을 마쳤습니다. 통합 결정을 기다립니다.");
  b.pendingPermissions = [{ id: "permission-B" }];
  for (const event of ["permission-required", "finished"]) {
    if (event === "finished") {
      b.pendingPermissions = [];
      b.status = "idle";
      messages.set("B", "B 결과입니다.");
    }
    const list = await read();
    const listedB = list.find(row => row.id === "B");
    expect(listedB.status).toBe(event === "finished" ? "idle" : "running");
    expect(listedB).not.toHaveProperty("pendingPermissions");
    expect(listedB).not.toHaveProperty("activeTurn");
    expect(list.filter(row => row.title === "검토")).toHaveLength(2);
    expect(list.find(row => row.id === "A")).toMatchObject({ projectId: "work", status: "idle", activityAt: a.updatedAt });
    const evidence = await read({ sessionId: "A" });
    expect(evidence).toMatchObject({ sessionId: "A", turns: [{ role: "assistant", text: messages.get("A") }] });
  }
  expect(timelineReads).toEqual(["A", "A"]);
});

test("빈 발췌·재개·목록 오류·관리 해제에서 옛 근거를 재사용하지 않는다", async () => {
  const { agents: [, a], prefs, sdk, read, timelineReads } = await openBoard();
  a.status = "idle";
  expect((await read({ sessionId: "A" })).turns).toEqual([]);
  const idle = await read();
  a.status = "running";
  expect(await read({ sessionId: "A" })).toEqual({ sessionId: "A", status: "running", turns: [] });
  expect(idle.find(row => row.id === "A").status).toBe("idle");
  expect((await read()).find(row => row.id === "A").status).toBe("running");
  prefs.change(scope => { scope.projects = ["control"]; });
  expect((await read()).map(row => row.id)).toEqual(["coord"]);
  await expect(read({ sessionId: "A" })).rejects.toThrow("관리 대상");
  expect(timelineReads).toEqual(["A"]);
  sdk.agents.list = async () => { throw new Error("호스트 조회 오류"); };
  await expect(read()).rejects.toThrow("호스트 조회 오류");
});
