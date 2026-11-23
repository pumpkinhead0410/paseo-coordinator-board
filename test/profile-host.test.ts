import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileHost, TOP_N, type ProfileHostOptions } from "../server/profile-host";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// 임시 폴더의 가짜 profile_selector.py·quota_state.py와 가짜 paseo만 쓴다. 실제 호스트 파일과 상태는 건드리지 않는다.
const fakeScript = `import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
name = os.path.basename(__file__)
op = sys.argv[-1] if name == 'quota_state.py' else 'select'
request = sys.stdin.read()
key = name + ':' + op
log = os.path.join(root, 'calls.log')
with open(log, 'a') as f:
    f.write(json.dumps({'key': key, 'argv': sys.argv[1:], 'request': request}) + '\\n')
count = sum(1 for line in open(log) if json.loads(line)['key'] == key)
queue = json.load(open(os.path.join(root, 'script.json')))[key]
step = queue[min(count, len(queue)) - 1]
sys.stdout.write(step['raw'] if 'raw' in step else json.dumps(step['body']))
sys.exit(step.get('code', 0))
`;
const fakePaseo = `#!/bin/sh
echo "$@" >> "$FAKE_ROOT/paseo.log"
case "$PASEO_MODE" in
  ok) echo '[{"providerId":"claude","status":"available"}]' ;;
  object) echo '{"providers":[]}' ;;
  fail) exit 3 ;;
  hang) sleep 60 & echo $! > "$FAKE_ROOT/child.pid"; sleep 60 ;;
esac
`;

type Step = { body?: unknown; raw?: string; code?: number };
function fixture(script: Record<string, Step[]> = {}, mode = "ok") {
  const root = mkdtempSync(join(tmpdir(), "profile-host-"));
  dirs.push(root);
  mkdirSync(join(root, "guides"));
  mkdirSync(join(root, "paseo"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "guides", "paseo.md"), "");
  for (const name of ["profile_selector.py", "quota_state.py"]) writeFileSync(join(root, "paseo", name), fakeScript);
  writeFileSync(join(root, "bin", "paseo"), fakePaseo);
  chmodSync(join(root, "bin", "paseo"), 0o755);
  writeFileSync(join(root, "script.json"), JSON.stringify(script));
  const options: ProfileHostOptions = {
    guidePath: join(root, "guides", "paseo.md"), lockRetryMs: 5, scriptTimeoutMs: 5000,
    env: { ...process.env, PATH: join(root, "bin") + ":" + process.env.PATH, FAKE_ROOT: root, PASEO_MODE: mode },
  };
  const calls = (key?: string) => (existsSync(join(root, "calls.log")) ? readFileSync(join(root, "calls.log"), "utf8").trim().split("\n").filter(Boolean) : [])
    .map(line => JSON.parse(line) as { key: string; argv: string[]; request: string }).filter(c => !key || c.key === key);
  const paseoCalls = () => existsSync(join(root, "paseo.log")) ? readFileSync(join(root, "paseo.log"), "utf8").trim().split("\n") : [];
  return { root, options, calls, paseoCalls };
}

const summary = (id: string, provider: string, model: string) => ({ id, provider, model, quotaPool: provider });
const selected = (alternatives = [summary("deep.codex.astra.high", "codex", "gpt-6.2-astra")], extra: Record<string, unknown> = {}) => ({
  status: "selected", defer: false,
  selected: summary("deep.claude.opus.high", "claude", "claude-opus-5-5"),
  createAgentArgs: { provider: "claude/claude-opus-5-5", settings: { modeId: "auto", thinkingOptionId: "high" } },
  alternatives, claimCandidates: [], earliestResetAt: null, reason: "deep.claude.opus.high via stateless-time-bucket among 2 eligible", ...extra,
});
const claimed = (leaseSeconds = 60, command = ["paseo", "usage", "--json"]) => ({ claimed: true, token: "tok", leaseSeconds, command });
const due = [{ provider: "claude", model: "claude-opus-5-5" }];

test("저장소 경로가 없거나 스크립트가 없으면 예외 없이 unavailable을 돌려준다", async () => {
  const f = fixture();
  const missing = createProfileHost({ ...f.options, guidePath: join(f.root, "none", "paseo.md") });
  expect(await missing.rank("deep", "high")).toMatchObject({ status: "unavailable" });
  expect(await missing.refresh(due)).toEqual({ kind: "failed", reason: "unavailable" });
  rmSync(join(f.root, "paseo", "quota_state.py"));
  expect(await createProfileHost(f.options).rank("deep", "high")).toMatchObject({ status: "unavailable" });
});

test("rank는 자유 선택(topN 10, requiredProfileId 없음)으로 묻고 selected와 alternatives를 하나의 순위로 합친다", async () => {
  const f = fixture({ "profile_selector.py:select": [{ body: selected() }] });
  const host = createProfileHost({ ...f.options, profilesPath: "/tmp/p.json", statePath: "/tmp/s.json" });
  const ranking = await host.rank("deep", "high");
  expect(ranking).toEqual({
    status: "ranked", covered: true, refreshDue: [], why: expect.stringContaining("deep.claude.opus.high"),
    profiles: [
      { id: "deep.claude.opus.high", quotaPool: "claude", modeId: "auto", route: { provider: "claude", model: "claude-opus-5-5", effort: "high" } },
      { id: "deep.codex.astra.high", quotaPool: "codex", route: { provider: "codex", model: "gpt-6.2-astra", effort: "high" } },
    ],
  });
  const [call] = f.calls("profile_selector.py:select");
  expect(JSON.parse(call.request)).toEqual({ role: "deep", effort: "high", topN: TOP_N, allowEffortDowngrade: false });
  expect(call.argv).toEqual(["--profiles", "/tmp/p.json", "--state", "/tmp/s.json"]);
});

test("후보가 topN만큼 꽉 차면 목록을 다 덮지 못한 것으로 표시한다", async () => {
  const alternatives = Array.from({ length: TOP_N }, (_, i) => summary("deep.x.m" + i + ".high", "codex", "m" + i));
  const f = fixture({ "profile_selector.py:select": [{ body: selected(alternatives) }] });
  expect(await createProfileHost(f.options).rank("deep", "high")).toMatchObject({ status: "ranked", covered: false });
});

test("describe는 requiredProfileId로 한 프로필의 권한 모드를 받아 온다", async () => {
  const f = fixture({ "profile_selector.py:select": [{ body: selected([]) }] });
  const described = await createProfileHost(f.options).describe("deep.claude.opus.high");
  expect(described).toMatchObject({ status: "described", profile: { modeId: "auto", route: { effort: "high" } } });
  expect(JSON.parse(f.calls()[0].request)).toEqual({ requiredProfileId: "deep.claude.opus.high", topN: 0, allowEffortDowngrade: false });
});

test("no-match와 all-exhausted는 사유와 갱신 후보를 그대로 전달한다", async () => {
  const body = { status: "all-exhausted", defer: false, selected: null, createAgentArgs: null, alternatives: [], claimCandidates: due, earliestResetAt: "2026-11-25T02:33:00Z", reason: "all eligible profiles are exhausted" };
  const f = fixture({ "profile_selector.py:select": [{ body }, { body: { ...body, status: "no-match", earliestResetAt: null } }] });
  const host = createProfileHost(f.options);
  expect(await host.rank("deep", "high")).toEqual({ status: "all-exhausted", why: body.reason, earliestResetAt: "2026-11-25T02:33:00Z", refreshDue: due });
  expect(await host.rank("deep", "high")).toMatchObject({ status: "no-match", earliestResetAt: null });
});

test("exit 2가 잠금 경합이면 한 번만 다시 시도하고, 손상·스키마 오류는 곧바로 보류한다", async () => {
  const defer = (reason: string) => ({ status: "defer", defer: true, selected: null, createAgentArgs: null, alternatives: [], claimCandidates: [], earliestResetAt: null, reason });
  const retry = fixture({ "profile_selector.py:select": [{ code: 2, body: defer("lock unavailable; defer new query and assignment") }, { body: selected() }] });
  expect(await createProfileHost(retry.options).rank("deep", "high")).toMatchObject({ status: "ranked" });
  expect(retry.calls()).toHaveLength(2);

  const stuck = fixture({ "profile_selector.py:select": [{ code: 2, body: defer("lock unavailable; defer new query and assignment") }] });
  expect(await createProfileHost(stuck.options).rank("deep", "high")).toMatchObject({ status: "defer" });
  expect(stuck.calls()).toHaveLength(2);

  const damaged = fixture({ "profile_selector.py:select": [{ code: 2, body: defer("damaged or incompatible state; preserve file and defer") }] });
  expect(await createProfileHost(damaged.options).rank("deep", "high")).toMatchObject({ status: "defer", why: expect.stringContaining("damaged") });
  expect(damaged.calls()).toHaveLength(1);
});

test("깨진 출력이나 예상 밖 종료 코드는 unavailable이다", async () => {
  for (const step of [{ raw: "not json" }, { raw: "{}" }, { body: selected(), code: 1 }]) {
    const f = fixture({ "profile_selector.py:select": [step] });
    expect(await createProfileHost(f.options).rank("deep", "high")).toMatchObject({ status: "unavailable" });
  }
});

test("조회권을 얻지 못하면(claimed:false) 명령을 한 번도 실행하지 않는다", async () => {
  for (const reason of ["not-due", "query-in-progress"] as const) {
    const f = fixture({ "quota_state.py:claim-query": [{ body: { claimed: false, reason } }] });
    expect(await createProfileHost(f.options).refresh(due)).toEqual({ kind: "skipped", reason });
    expect(f.paseoCalls()).toEqual([]);
    expect(f.calls("quota_state.py:finish-query")).toEqual([]);
  }
  const deferred = fixture({ "quota_state.py:claim-query": [{ code: 2, body: { defer: true, error: "lock unavailable" } }] });
  expect(await createProfileHost(deferred.options).refresh(due)).toEqual({ kind: "skipped", reason: "deferred" });
  expect(deferred.paseoCalls()).toEqual([]);
});

test("조회권을 얻으면 paseo usage --json을 한 번 실행하고 최상위 배열을 그대로 finish-query에 넣는다", async () => {
  const f = fixture({ "quota_state.py:claim-query": [{ body: claimed() }], "quota_state.py:finish-query": [{ body: { accepted: true } }] });
  expect(await createProfileHost({ ...f.options, statePath: "/tmp/s.json" }).refresh(due)).toEqual({ kind: "refreshed" });
  expect(f.paseoCalls()).toEqual(["usage --json"]);
  expect(JSON.parse(f.calls("quota_state.py:claim-query")[0].request)).toEqual({ candidates: due });
  const finish = f.calls("quota_state.py:finish-query")[0];
  expect(JSON.parse(finish.request)).toEqual({ token: "tok", reports: [{ providerId: "claude", status: "available" }] });
  expect(finish.argv).toEqual(["--state", "/tmp/s.json", "finish-query"]);
});

test("finish-query가 토큰을 거부하면 stale-token 실패로 보고한다", async () => {
  const f = fixture({ "quota_state.py:claim-query": [{ body: claimed() }], "quota_state.py:finish-query": [{ body: { accepted: false, reason: "stale-token" } }] });
  expect(await createProfileHost(f.options).refresh(due)).toEqual({ kind: "failed", reason: "stale-token" });
});

test("허용 목록 밖 명령은 실행하지 않고 connectionError로 조회권을 반환한다", async () => {
  for (const command of [["sh", "-c", "touch pwned"], ["paseo", "usage", "--evil", "--json"], ["paseo", "usage"], ["paseo", "providers", "--json"], ["paseo", "usage", "--json", "--json"]]) {
    const f = fixture({ "quota_state.py:claim-query": [{ body: claimed(60, command) }], "quota_state.py:finish-query": [{ body: { accepted: true } }] });
    expect(await createProfileHost(f.options).refresh(due)).toEqual({ kind: "failed", reason: "bad-command" });
    expect(f.paseoCalls()).toEqual([]);
    expect(JSON.parse(f.calls("quota_state.py:finish-query")[0].request)).toEqual({ token: "tok", reports: [], connectionError: true });
  }
  const force = fixture({ "quota_state.py:claim-query": [{ body: claimed(60, ["paseo", "usage", "--refresh", "--json"]) }], "quota_state.py:finish-query": [{ body: { accepted: true } }] });
  expect(await createProfileHost(force.options).refresh(due)).toEqual({ kind: "refreshed" });
  expect(force.paseoCalls()).toEqual(["usage --refresh --json"]);
});

test("명령이 실패하거나 배열이 아닌 출력을 내면 connectionError로 반환한다", async () => {
  for (const mode of ["fail", "object"]) {
    const f = fixture({ "quota_state.py:claim-query": [{ body: claimed() }], "quota_state.py:finish-query": [{ body: { accepted: true } }] }, mode);
    expect(await createProfileHost(f.options).refresh(due)).toEqual({ kind: "failed", reason: "command-error" });
    expect(JSON.parse(f.calls("quota_state.py:finish-query")[0].request)).toEqual({ token: "tok", reports: [], connectionError: true });
  }
});

function alive(pid: number) {
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
}

test("시간이 넘으면 프로세스 그룹 전체를 종료하고 connectionError로 반환한다", async () => {
  const f = fixture({ "quota_state.py:claim-query": [{ body: claimed() }], "quota_state.py:finish-query": [{ body: { accepted: true } }] }, "hang");
  const started = performance.now();
  expect(await createProfileHost({ ...f.options, commandCapMs: 400 }).refresh(due)).toEqual({ kind: "failed", reason: "timeout" });
  expect(performance.now() - started).toBeLessThan(5000);
  const child = Number(readFileSync(join(f.root, "child.pid"), "utf8"));
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(alive(child)).toBe(false);
  expect(JSON.parse(f.calls("quota_state.py:finish-query")[0].request)).toEqual({ token: "tok", reports: [], connectionError: true });
});

test("남은 조회권이 부족하면 명령을 시작하지 않고 반환한다", async () => {
  // 시간 제한은 min(상한, lease − 경과 − 10초)입니다.
  const f = fixture({ "quota_state.py:claim-query": [{ body: claimed(9) }], "quota_state.py:finish-query": [{ body: { accepted: true } }] });
  expect(await createProfileHost(f.options).refresh(due)).toEqual({ kind: "failed", reason: "timeout" });
  expect(f.paseoCalls()).toEqual([]);
  const clock = fixture({ "quota_state.py:claim-query": [{ body: claimed(60) }], "quota_state.py:finish-query": [{ body: { accepted: true } }] });
  let now = 0;
  expect(await createProfileHost({ ...clock.options, clock: () => (now += 51_000) }).refresh(due)).toEqual({ kind: "failed", reason: "timeout" });
  expect(clock.paseoCalls()).toEqual([]);
});

test("같은 데몬 안의 동시 갱신 요청은 하나로 묶는다", async () => {
  const f = fixture({ "quota_state.py:claim-query": [{ body: claimed() }], "quota_state.py:finish-query": [{ body: { accepted: true } }] });
  const host = createProfileHost(f.options);
  const results = await Promise.all([host.refresh(due), host.refresh(due), host.refresh(due)]);
  expect(results).toEqual([{ kind: "refreshed" }, { kind: "refreshed" }, { kind: "refreshed" }]);
  expect(f.calls("quota_state.py:claim-query")).toHaveLength(1);
  expect(f.paseoCalls()).toEqual(["usage --json"]);
  // 끝난 뒤에는 새 갱신을 시작할 수 있다.
  await host.refresh(due);
  expect(f.calls("quota_state.py:claim-query")).toHaveLength(2);
});
