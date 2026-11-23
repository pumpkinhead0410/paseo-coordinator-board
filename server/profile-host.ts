import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { RouteChoice } from "../shared/dispatch";
import type { SelectorEffort, SelectorRole } from "../shared/route-decision";

// 이 모듈만 프로세스를 실행하고, 호스트의 Selector·quota_state JSON 계약을 압니다.
// 공개 메서드는 예외를 던지지 않고 결과 타입으로 실패를 돌려줍니다.

export const TOP_N = 10;

export type RefreshCandidate = { provider: string; model: string; features?: string[] };
export type RankedProfile = { id: string; route: RouteChoice; quotaPool: string; modeId?: string };
export type Failure =
  | { status: "no-match" | "all-exhausted"; why: string; earliestResetAt: string | null; refreshDue: RefreshCandidate[] }
  | { status: "defer" | "unavailable"; why: string; refreshDue: [] };
export type Ranking = { status: "ranked"; profiles: RankedProfile[]; why: string; covered: boolean; refreshDue: RefreshCandidate[] } | Failure;
export type Described = { status: "described"; profile: RankedProfile & { modeId: string } } | Failure;
export type RefreshOutcome =
  | { kind: "refreshed" }
  | { kind: "skipped"; reason: "not-due" | "query-in-progress" | "deferred" }
  | { kind: "failed"; reason: "unavailable" | "bad-command" | "timeout" | "command-error" | "stale-token" };

export interface ProfileHost {
  rank(role: SelectorRole, effort: SelectorEffort): Promise<Ranking>;
  describe(profileId: string): Promise<Described>;
  refresh(due: readonly RefreshCandidate[]): Promise<RefreshOutcome>;
}

export type ProfileHostOptions = {
  guidePath?: string;
  python?: string;
  profilesPath?: string;
  statePath?: string;
  env?: NodeJS.ProcessEnv;
  scriptTimeoutMs?: number;
  commandCapMs?: number;
  lockRetryMs?: number;
  clock?: () => number;
};

const summary = z.object({ id: z.string().min(1), provider: z.string().min(1), model: z.string().min(1), quotaPool: z.string() });
const claimCandidate = z.object({ provider: z.string().min(1), model: z.string().min(1), features: z.array(z.string()).optional() });
const selectorWire = z.object({
  status: z.enum(["selected", "no-match", "all-exhausted", "defer"]),
  selected: summary.nullable(),
  createAgentArgs: z.object({
    provider: z.string(),
    settings: z.object({ modeId: z.string().min(1), thinkingOptionId: z.string().optional() }),
  }).nullable(),
  alternatives: z.array(summary),
  claimCandidates: z.array(claimCandidate),
  earliestResetAt: z.string().nullable(),
  reason: z.string(),
});
const claimWire = z.object({
  claimed: z.boolean().optional(), token: z.string().optional(), leaseSeconds: z.number().optional(),
  command: z.array(z.string()).optional(), reason: z.string().optional(), defer: z.boolean().optional(),
});
const finishWire = z.object({ accepted: z.boolean() });

type Run = { code: number | null; stdout: string; timedOut: boolean; error: boolean };
const MAX_OUTPUT = 4 * 1024 * 1024;

function killGroup(child: ChildProcess) {
  try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

function run(file: string, args: string[], input: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try { child = spawn(file, args, { stdio: ["pipe", "pipe", "ignore"], detached: true, env: env ?? process.env, shell: false }); }
    catch { resolve({ code: null, stdout: "", timedOut: false, error: true }); return; }
    let out = "";
    let done = false;
    const finish = (result: Run) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => { killGroup(child); finish({ code: null, stdout: out, timedOut: true, error: false }); }, Math.max(1, timeoutMs));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
      if (out.length > MAX_OUTPUT) { killGroup(child); finish({ code: null, stdout: "", timedOut: false, error: true }); }
    });
    child.on("error", () => finish({ code: null, stdout: out, timedOut: false, error: true }));
    child.on("close", code => finish({ code, stdout: out, timedOut: false, error: false }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const isLockDefer = (value: unknown) => typeof value === "object" && value !== null &&
  (value as { defer?: unknown }).defer === true && /^lock unavailable/.test(String((value as { error?: unknown }).error ?? ""));

// 허용 목록: paseo usage [--refresh] --json 뿐입니다.
function allowedCommand(command: readonly string[] | undefined): command is string[] {
  if (!command || command[0] !== "paseo" || command[1] !== "usage" || !command.includes("--json")) return false;
  return command.slice(2).every(flag => flag === "--json" || flag === "--refresh") && new Set(command).size === command.length;
}

const unavailable = (why: string): Failure => ({ status: "unavailable", why, refreshDue: [] });

export function createProfileHost(options: ProfileHostOptions = {}): ProfileHost {
  const python = options.python ?? "python3";
  const scriptTimeout = options.scriptTimeoutMs ?? 5_000;
  const commandCap = options.commandCapMs ?? 25_000;
  const lockRetry = options.lockRetryMs ?? 250;
  const clock = options.clock ?? (() => performance.now());
  let inFlight: Promise<RefreshOutcome> | null = null;

  // 호출마다 realpath로 다시 찾습니다. 저장소가 옮겨져도 오래된 경로를 쓰지 않습니다.
  async function locate(): Promise<string | null> {
    try {
      const guide = await realpath(options.guidePath ?? join(homedir(), ".agents", "guides", "paseo.md"));
      const root = dirname(dirname(guide));
      for (const name of ["profile_selector.py", "quota_state.py"]) {
        if (!(await stat(join(root, "paseo", name))).isFile()) return null;
      }
      return root;
    } catch {
      return null;
    }
  }

  async function selector(request: Record<string, unknown>): Promise<{ ok: true; body: z.infer<typeof selectorWire>; code: number } | { ok: false; failure: Failure }> {
    const root = await locate();
    if (!root) return { ok: false, failure: unavailable("selector script not found") };
    const args = [join(root, "paseo", "profile_selector.py"),
      ...(options.profilesPath ? ["--profiles", options.profilesPath] : []), ...(options.statePath ? ["--state", options.statePath] : [])];
    for (let attempt = 0; ; attempt++) {
      const result = await run(python, args, JSON.stringify(request), scriptTimeout, options.env);
      if (result.error || result.timedOut || (result.code !== 0 && result.code !== 2)) return { ok: false, failure: unavailable("selector did not run") };
      let body: z.infer<typeof selectorWire>;
      try { body = selectorWire.parse(JSON.parse(result.stdout)); }
      catch { return { ok: false, failure: unavailable("selector output not understood") }; }
      // 잠금 경합만 한 번 다시 시도합니다. 손상·스키마 불일치는 곧바로 보류합니다.
      if (result.code === 2 && attempt === 0 && /^lock unavailable/.test(body.reason)) { await sleep(lockRetry); continue; }
      return { ok: true, body, code: result.code };
    }
  }

  function failure(body: z.infer<typeof selectorWire>, code: number): Failure | null {
    if (code === 2 || body.status === "defer") return { status: "defer", why: body.reason, refreshDue: [] };
    if (body.status === "no-match" || body.status === "all-exhausted")
      return { status: body.status, why: body.reason, earliestResetAt: body.earliestResetAt, refreshDue: body.claimCandidates };
    return null;
  }

  const effortOf = (id: string) => id.split(".").at(-1)!;

  async function quota(root: string, operation: "claim-query" | "finish-query", request: unknown) {
    const args = [join(root, "paseo", "quota_state.py"), ...(options.statePath ? ["--state", options.statePath] : []), operation];
    const result = await run(python, args, JSON.stringify(request), scriptTimeout, options.env);
    if (result.error || result.timedOut || (result.code !== 0 && result.code !== 2)) return null;
    try { return JSON.parse(result.stdout) as unknown; } catch { return null; }
  }

  async function refreshOnce(due: readonly RefreshCandidate[]): Promise<RefreshOutcome> {
    const root = await locate();
    if (!root) return { kind: "failed", reason: "unavailable" };
    const started = clock();
    const rawClaim = await quota(root, "claim-query", { candidates: due });
    const parsed = claimWire.safeParse(rawClaim);
    if (!parsed.success) return { kind: "failed", reason: "unavailable" };
    const claim = parsed.data;
    if (claim.defer) return { kind: "skipped", reason: "deferred" };
    // 조회권을 얻지 못했으면 명령을 실행하지 않고 현재 공유 상태를 씁니다.
    if (!claim.claimed || !claim.token) {
      return { kind: "skipped", reason: claim.reason === "query-in-progress" ? "query-in-progress" : "not-due" };
    }
    const token = claim.token;
    const abandon = async (reason: "bad-command" | "timeout" | "command-error"): Promise<RefreshOutcome> => {
      await quota(root, "finish-query", { token, reports: [], connectionError: true });
      return { kind: "failed", reason };
    };
    if (!allowedCommand(claim.command)) return abandon("bad-command");
    const leaseMs = (claim.leaseSeconds ?? 60) * 1000;
    // finish-query와 시계 오차를 위해 10초를 남깁니다.
    const budget = Math.min(commandCap, leaseMs - (clock() - started) - 10_000);
    if (budget <= 0) return abandon("timeout");
    const result = await run(claim.command[0], claim.command.slice(1), "", budget, options.env);
    if (result.timedOut) return abandon("timeout");
    let reports: unknown;
    try { reports = JSON.parse(result.stdout); } catch { reports = null; }
    // paseo usage --json은 최상위 배열을 출력합니다. 그대로 reports에 넣습니다.
    if (result.error || result.code !== 0 || !Array.isArray(reports)) return abandon("command-error");
    let rawFinish = await quota(root, "finish-query", { token, reports });
    // 다른 세션의 짧은 쓰기 잠금과 겹치면 한 번만 다시 반영합니다. 손상 등 다른 보류는 재시도하지 않습니다.
    if (isLockDefer(rawFinish)) { await sleep(lockRetry); rawFinish = await quota(root, "finish-query", { token, reports }); }
    const finished = finishWire.safeParse(rawFinish);
    return finished.success && finished.data.accepted ? { kind: "refreshed" } : { kind: "failed", reason: "stale-token" };
  }

  return {
    async rank(role, effort) {
      const got = await selector({ role, effort, topN: TOP_N, allowEffortDowngrade: false });
      if (!got.ok) return got.failure;
      const { body, code } = got;
      const failed = failure(body, code);
      if (failed) return failed;
      if (!body.selected || !body.createAgentArgs) return unavailable("selector returned no profile");
      const first: RankedProfile = {
        id: body.selected.id, quotaPool: body.selected.quotaPool, modeId: body.createAgentArgs.settings.modeId,
        route: { provider: body.selected.provider, model: body.selected.model, effort: body.createAgentArgs.settings.thinkingOptionId ?? null },
      };
      const rest = body.alternatives.map((p): RankedProfile => ({
        id: p.id, quotaPool: p.quotaPool, route: { provider: p.provider, model: p.model, effort: effortOf(p.id) },
      }));
      return { status: "ranked", profiles: [first, ...rest], why: body.reason, covered: body.alternatives.length < TOP_N, refreshDue: body.claimCandidates };
    },

    async describe(profileId) {
      const got = await selector({ requiredProfileId: profileId, topN: 0, allowEffortDowngrade: false });
      if (!got.ok) return got.failure;
      const { body, code } = got;
      const failed = failure(body, code);
      if (failed) return failed;
      if (!body.selected || !body.createAgentArgs) return unavailable("selector returned no profile");
      return {
        status: "described",
        profile: {
          id: body.selected.id, quotaPool: body.selected.quotaPool, modeId: body.createAgentArgs.settings.modeId,
          route: { provider: body.selected.provider, model: body.selected.model, effort: body.createAgentArgs.settings.thinkingOptionId ?? null },
        },
      };
    },

    refresh(due) {
      inFlight ??= refreshOnce(due).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
