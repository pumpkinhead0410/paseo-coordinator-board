import { execCommand } from "@getpaseo/plugin/server";
import { join } from "node:path";
import { z } from "zod";
import { repositorySlug } from "../shared/prs";

export type IssueState = "OPEN" | "CLOSED" | "UNKNOWN";
export type IssueCloseReason = "COMPLETED" | "NOT_PLANNED" | "REOPENED" | "DUPLICATE" | "UNKNOWN";
export type ClosingCommitResolution =
  | { status: "commit"; sha: string }
  | { status: "manual" }
  | { status: "foreign_commit" }
  | { status: "unavailable" };
export type IssueOutcome = {
  state: IssueState;
  stateReason: IssueCloseReason;
  url?: string;
  closing?: ClosingCommitResolution;
  closingCommits?: string[];
};
export type CommitCheckStatus = "passed" | "failed" | "pending" | "unavailable";
export type CommitVerification = {
  onMain: boolean;
  resolvedSha?: string;
  issues?: number[];
  checks: CommitCheckStatus;
};
export type OutcomeVerifier = {
  verifyIssue(repo: string, issue: number): Promise<IssueOutcome>;
  verifyMainCommit(workspacePath: string | undefined, repo: string, commit: string): Promise<CommitVerification>;
};

const commitHashPattern = /^[0-9a-f]{7,40}$/i;
const failingConclusions = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);
const nonFailingConclusions = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

const rawIssue = z.object({
  state: z.enum(["OPEN", "CLOSED"]),
  stateReason: z.string().nullable().optional(),
  url: z.string(),
});
const rawCheckRuns = z.object({
  total_count: z.number().int().nonnegative().optional(),
  check_runs: z.array(z.object({
    status: z.string().nullish(),
    conclusion: z.string().nullish(),
  })),
});
const rawCommitStatus = z.object({
  state: z.string().nullish(),
  total_count: z.number().int().nonnegative().optional(),
  statuses: z.array(z.object({ state: z.string().nullish() })).default([]),
});

async function runCommand(command: "git" | "gh", args: string[]): Promise<string> {
  const options = {
    shell: false,
    timeout: command === "gh" ? 15_000 : 3_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" },
  };
  try {
    return (await execCommand(command, args, options)).stdout;
  } catch (error) {
    if (process.platform !== "darwin" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    for (const directory of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) {
      try {
        return (await execCommand(join(directory, command), args, options)).stdout;
      } catch (next) {
        if ((next as NodeJS.ErrnoException).code !== "ENOENT") throw next;
      }
    }
    throw error;
  }
}

export function normalizeCloseReason(reason: string | null | undefined): IssueCloseReason {
  const upper = reason?.trim().toUpperCase();
  if (upper === "COMPLETED" || upper === "NOT_PLANNED" || upper === "REOPENED" || upper === "DUPLICATE") {
    return upper;
  }
  return "UNKNOWN";
}

export function summarizeCommitChecks(
  checkRuns: { status?: string | null; conclusion?: string | null }[],
  commitStatuses: { state?: string | null }[],
): CommitCheckStatus {
  const total = checkRuns.length + commitStatuses.length;
  if (total === 0) return "unavailable";
  for (const run of checkRuns) {
    const conclusion = run.conclusion?.trim().toUpperCase() ?? "";
    if (conclusion && failingConclusions.has(conclusion)) return "failed";
  }
  for (const status of commitStatuses) {
    const state = status.state?.trim().toUpperCase() ?? "";
    if (state === "FAILURE" || state === "ERROR") return "failed";
  }
  for (const run of checkRuns) {
    const status = run.status?.trim().toUpperCase() ?? "";
    if (status !== "COMPLETED") return "pending";
  }
  for (const status of commitStatuses) {
    const state = status.state?.trim().toUpperCase() ?? "";
    if (state === "PENDING" || state === "EXPECTED") return "pending";
  }
  let hasSuccess = false;
  for (const run of checkRuns) {
    const conclusion = run.conclusion?.trim().toUpperCase() ?? "";
    if (!nonFailingConclusions.has(conclusion)) return "failed";
    if (conclusion === "SUCCESS") hasSuccess = true;
  }
  for (const status of commitStatuses) {
    const state = status.state?.trim().toUpperCase() ?? "";
    if (state !== "SUCCESS") return "failed";
    hasSuccess = true;
  }
  return hasSuccess ? "passed" : "unavailable";
}

const rawCommitMeta = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/i),
  commit: z.object({ message: z.string().optional() }).optional(),
});

const negatedClosePrefixPattern = /(?:(?:does|did|will|would|can|could|should)\s+not|(?:doesn't|didn't|won't|can't|not|never|no))\s+$/i;

function extractCommitIssues(message: string | undefined, targetRepo: string): number[] | undefined {
  if (!message) return undefined;
  const expectedRepo = targetRepo.toLowerCase();
  const cleaned = message
    .replace(/https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+\b/gi, " ")
    .replace(/(?:\bPR\b|pull\s*request)\s*(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+\b/gi, " ");
  const ids = new Set<number>();
  const closingRefPattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+(?:https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)|(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+))\b/gi;
  for (const match of cleaned.matchAll(closingRefPattern)) {
    const start = match.index ?? 0;
    const prefix = cleaned.slice(Math.max(0, start - 24), start);
    if (negatedClosePrefixPattern.test(prefix)) continue;
    const repo = (match[1] ?? match[3])?.toLowerCase();
    if (repo && repo !== expectedRepo) continue;
    const n = Number(match[2] ?? match[4]);
    if (Number.isSafeInteger(n) && n > 0) ids.add(n);
  }
  return ids.size > 0 ? [...ids] : undefined;
}

async function resolveRemoteMainAncestry(
  repo: string,
  commit: string,
  runner: (command: "git" | "gh", args: string[]) => Promise<string>,
): Promise<{ onMain: boolean; resolvedSha?: string; issues?: number[] }> {
  try {
    const raw = (await runner("gh", ["api", `repos/${repo}/commits/${commit}`, "--jq", "{sha:.sha,commit:{message:.commit.message}}"])).trim();
    let sha = "";
    let issues: number[] | undefined;
    if (/^[0-9a-f]{40}$/i.test(raw)) {
      sha = raw.toLowerCase();
    } else {
      const parsed = rawCommitMeta.parse(JSON.parse(raw));
      sha = parsed.sha.toLowerCase();
      issues = extractCommitIssues(parsed.commit?.message, repo);
    }
    if (!/^[0-9a-f]{40}$/.test(sha)) return { onMain: false };
    for (const base of ["main", "master"]) {
      try {
        const status = (await runner("gh", ["api", `repos/${repo}/compare/${base}...${sha}`, "--jq", ".status"])).trim().toLowerCase();
        if (status === "identical" || status === "behind") return { onMain: true, resolvedSha: sha, ...(issues ? { issues } : {}) };
      } catch {
        continue;
      }
    }
    return { onMain: false, resolvedSha: sha, ...(issues ? { issues } : {}) };
  } catch {
    return { onMain: false };
  }
}

const maxCheckPages = 10;

async function fetchAllCheckRuns(
  repo: string,
  resolvedSha: string,
  runner: (command: "git" | "gh", args: string[]) => Promise<string>,
): Promise<{ runs: { status?: string | null; conclusion?: string | null }[]; complete: boolean }> {
  const runs: { status?: string | null; conclusion?: string | null }[] = [];
  let expectedTotal: number | undefined;
  try {
    for (let page = 1; page <= maxCheckPages; page += 1) {
      const endpoint = `repos/${repo}/commits/${resolvedSha}/check-runs?per_page=100&page=${page}`;
      const raw = await runner("gh", ["api", endpoint]);
      const parsed = rawCheckRuns.parse(JSON.parse(raw));
      if (parsed.total_count !== undefined) expectedTotal = parsed.total_count;
      runs.push(...parsed.check_runs);
      if (expectedTotal !== undefined && runs.length >= expectedTotal) {
        return { runs, complete: true };
      }
      if (parsed.check_runs.length === 0) {
        return { runs, complete: expectedTotal === undefined || runs.length >= expectedTotal };
      }
      if (expectedTotal === undefined && parsed.check_runs.length < 100) {
        return { runs, complete: true };
      }
    }
    return { runs, complete: expectedTotal !== undefined && runs.length >= expectedTotal };
  } catch {
    return { runs, complete: false };
  }
}

async function fetchAllCommitStatuses(
  repo: string,
  resolvedSha: string,
  runner: (command: "git" | "gh", args: string[]) => Promise<string>,
): Promise<{ statuses: { state?: string | null }[]; complete: boolean }> {
  const statuses: { state?: string | null }[] = [];
  let expectedTotal: number | undefined;
  try {
    for (let page = 1; page <= maxCheckPages; page += 1) {
      const endpoint = `repos/${repo}/commits/${resolvedSha}/status?per_page=100&page=${page}`;
      const raw = await runner("gh", ["api", endpoint]);
      const parsed = rawCommitStatus.parse(JSON.parse(raw));
      if (parsed.total_count !== undefined) expectedTotal = parsed.total_count;
      statuses.push(...parsed.statuses);
      if (expectedTotal !== undefined && statuses.length >= expectedTotal) {
        return { statuses, complete: true };
      }
      if (parsed.statuses.length === 0) {
        return { statuses, complete: expectedTotal === undefined || statuses.length >= expectedTotal };
      }
      if (expectedTotal === undefined && parsed.statuses.length < 100) {
        return { statuses, complete: true };
      }
    }
    return { statuses, complete: expectedTotal !== undefined && statuses.length >= expectedTotal };
  } catch {
    return { statuses, complete: false };
  }
}

async function lookupCommitChecks(
  repo: string,
  resolvedSha: string,
  runner: (command: "git" | "gh", args: string[]) => Promise<string>,
): Promise<CommitCheckStatus> {
  const [runsResult, statusResult] = await Promise.all([
    fetchAllCheckRuns(repo, resolvedSha, runner),
    fetchAllCommitStatuses(repo, resolvedSha, runner),
  ]);
  const summary = summarizeCommitChecks(runsResult.runs, statusResult.statuses);
  if (summary === "failed" || summary === "pending") return summary;
  if (!runsResult.complete || !statusResult.complete) return "unavailable";
  return summary;
}

const rawTimelineEvent = z.object({
  event: z.string().nullish(),
  commit_id: z.string().nullish(),
  commit_url: z.string().nullish(),
});

async function fetchLatestClosingCommit(
  repo: string,
  issue: number,
  runner: (command: "git" | "gh", args: string[]) => Promise<string>,
): Promise<ClosingCommitResolution> {
  const expectedPrefix = `https://api.github.com/repos/${repo.toLowerCase()}/commits/`;
  let latestClosed: z.output<typeof rawTimelineEvent> | undefined;
  let complete = false;
  try {
    for (let page = 1; page <= maxCheckPages; page += 1) {
      const raw = await runner("gh", ["api", `repos/${repo}/issues/${issue}/timeline?per_page=100&page=${page}`]);
      const events = z.array(rawTimelineEvent).parse(JSON.parse(raw));
      for (const ev of events) {
        if (ev.event === "reopened") {
          latestClosed = undefined;
        } else if (ev.event === "closed") {
          latestClosed = ev;
        }
      }
      if (events.length < 100) {
        complete = true;
        break;
      }
    }
  } catch {
    return { status: "unavailable" };
  }
  if (!complete || !latestClosed) return { status: "unavailable" };
  if (latestClosed.commit_id === undefined) return { status: "unavailable" };
  if (latestClosed.commit_id === null) {
    if (latestClosed.commit_url !== undefined && latestClosed.commit_url !== null) {
      return { status: "unavailable" };
    }
    return { status: "manual" };
  }
  const sha = latestClosed.commit_id.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) return { status: "unavailable" };
  if (typeof latestClosed.commit_url !== "string" || latestClosed.commit_url.trim() === "") {
    return { status: "unavailable" };
  }
  const url = latestClosed.commit_url.trim().toLowerCase();
  if (!url.startsWith(expectedPrefix)) {
    return { status: "foreign_commit" };
  }
  if (url !== `${expectedPrefix}${sha}`) {
    return { status: "unavailable" };
  }
  return { status: "commit", sha };
}

export function createOutcomeVerifier(
  runner: (command: "git" | "gh", args: string[]) => Promise<string> = runCommand,
): OutcomeVerifier {
  return {
    async verifyIssue(repo: string, issue: number): Promise<IssueOutcome> {
      const parsedRepo = repositorySlug.safeParse(repo);
      if (!parsedRepo.success || !Number.isSafeInteger(issue) || issue <= 0) {
        return { state: "UNKNOWN", stateReason: "UNKNOWN" };
      }
      try {
        const output = await runner("gh", [
          "issue",
          "view",
          String(issue),
          "--repo",
          `github.com/${parsedRepo.data}`,
          "--json",
          "state,stateReason,url",
        ]);
        const parsed = rawIssue.parse(JSON.parse(output));
        const expectedUrl = `https://github.com/${parsedRepo.data}/issues/${issue}`;
        if (parsed.url.toLowerCase() !== expectedUrl) {
          return { state: "UNKNOWN", stateReason: "UNKNOWN" };
        }
        const stateReason = normalizeCloseReason(parsed.stateReason);
        if (parsed.state === "CLOSED" && stateReason === "COMPLETED") {
          const closing = await fetchLatestClosingCommit(parsedRepo.data, issue, runner);
          return {
            state: parsed.state,
            stateReason,
            url: parsed.url,
            closing,
            ...(closing.status === "commit" ? { closingCommits: [closing.sha] } : {}),
          };
        }
        return {
          state: parsed.state,
          stateReason,
          url: parsed.url,
        };
      } catch {
        return { state: "UNKNOWN", stateReason: "UNKNOWN" };
      }
    },

    async verifyMainCommit(_workspacePath: string | undefined, repo: string, commit: string): Promise<CommitVerification> {
      const parsedRepo = repositorySlug.safeParse(repo);
      const trimmed = commit.trim();
      if (!parsedRepo.success || !commitHashPattern.test(trimmed)) {
        return { onMain: false, checks: "unavailable" };
      }
      const resolved = await resolveRemoteMainAncestry(parsedRepo.data, trimmed, runner);
      if (!resolved.onMain || !resolved.resolvedSha) {
        return { onMain: false, resolvedSha: resolved.resolvedSha, checks: "unavailable" };
      }
      const checks = await lookupCommitChecks(parsedRepo.data, resolved.resolvedSha, runner);
      return { onMain: true, resolvedSha: resolved.resolvedSha, ...(resolved.issues ? { issues: resolved.issues } : {}), checks };
    },
  };
}
