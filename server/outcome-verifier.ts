import { execCommand } from "@getpaseo/plugin/server";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { repositorySlug } from "../shared/prs";

export type IssueState = "OPEN" | "CLOSED" | "UNKNOWN";
export type IssueCloseReason = "COMPLETED" | "NOT_PLANNED" | "REOPENED" | "DUPLICATE" | "UNKNOWN";
export type IssueOutcome = {
  state: IssueState;
  stateReason: IssueCloseReason;
  url?: string;
};
export type CommitCheckStatus = "passed" | "failed" | "pending" | "unavailable";
export type CommitVerification = {
  onMain: boolean;
  resolvedSha?: string;
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
const greenConclusions = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

const rawIssue = z.object({
  state: z.enum(["OPEN", "CLOSED"]),
  stateReason: z.string().nullable().optional(),
  url: z.string(),
});
const rawCheckRuns = z.object({
  check_runs: z.array(z.object({
    status: z.string().nullish(),
    conclusion: z.string().nullish(),
  })),
});
const rawCommitStatus = z.object({
  state: z.string().nullish(),
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
  for (const run of checkRuns) {
    const conclusion = run.conclusion?.trim().toUpperCase() ?? "";
    if (!greenConclusions.has(conclusion)) return "failed";
  }
  for (const status of commitStatuses) {
    const state = status.state?.trim().toUpperCase() ?? "";
    if (state !== "SUCCESS") return "failed";
  }
  return "passed";
}

async function resolveLocalMainAncestry(
  workspacePath: string | undefined,
  commit: string,
  runner: (command: "git" | "gh", args: string[]) => Promise<string>,
): Promise<{ onMain: boolean; resolvedSha?: string } | null> {
  if (!workspacePath || !isAbsolute(workspacePath)) return null;
  try {
    const marker = await stat(join(workspacePath, ".git"));
    if (!marker.isFile() && !marker.isDirectory()) return null;
    const resolvedSha = (await runner("git", ["-C", workspacePath, "rev-parse", "--verify", `${commit}^{commit}`])).trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(resolvedSha)) return null;
    for (const ref of ["origin/main", "main", "origin/master", "master"]) {
      try {
        await runner("git", ["-C", workspacePath, "merge-base", "--is-ancestor", resolvedSha, ref]);
        return { onMain: true, resolvedSha };
      } catch {
        continue;
      }
    }
    return { onMain: false, resolvedSha };
  } catch {
    return null;
  }
}

async function resolveRemoteMainAncestry(
  repo: string,
  commit: string,
  runner: (command: "git" | "gh", args: string[]) => Promise<string>,
): Promise<{ onMain: boolean; resolvedSha?: string }> {
  try {
    const sha = (await runner("gh", ["api", `repos/${repo}/commits/${commit}`, "--jq", ".sha"])).trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sha)) return { onMain: false };
    for (const base of ["main", "master"]) {
      try {
        const status = (await runner("gh", ["api", `repos/${repo}/compare/${base}...${sha}`, "--jq", ".status"])).trim().toLowerCase();
        if (status === "identical" || status === "behind") return { onMain: true, resolvedSha: sha };
      } catch {
        continue;
      }
    }
    return { onMain: false, resolvedSha: sha };
  } catch {
    return { onMain: false };
  }
}

async function lookupCommitChecks(
  repo: string,
  resolvedSha: string,
  runner: (command: "git" | "gh", args: string[]) => Promise<string>,
): Promise<CommitCheckStatus> {
  try {
    const [runsRaw, statusRaw] = await Promise.all([
      runner("gh", ["api", `repos/${repo}/commits/${resolvedSha}/check-runs`]),
      runner("gh", ["api", `repos/${repo}/commits/${resolvedSha}/status`]),
    ]);
    const runs = rawCheckRuns.parse(JSON.parse(runsRaw));
    const status = rawCommitStatus.parse(JSON.parse(statusRaw));
    return summarizeCommitChecks(runs.check_runs, status.statuses);
  } catch {
    return "unavailable";
  }
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
        return {
          state: parsed.state,
          stateReason: normalizeCloseReason(parsed.stateReason),
          url: parsed.url,
        };
      } catch {
        return { state: "UNKNOWN", stateReason: "UNKNOWN" };
      }
    },

    async verifyMainCommit(workspacePath: string | undefined, repo: string, commit: string): Promise<CommitVerification> {
      const parsedRepo = repositorySlug.safeParse(repo);
      const trimmed = commit.trim();
      if (!parsedRepo.success || !commitHashPattern.test(trimmed)) {
        return { onMain: false, checks: "unavailable" };
      }
      const local = await resolveLocalMainAncestry(workspacePath, trimmed, runner);
      const resolved = local?.onMain ? local : await resolveRemoteMainAncestry(parsedRepo.data, trimmed, runner);
      if (!resolved.onMain || !resolved.resolvedSha) {
        return { onMain: false, resolvedSha: resolved.resolvedSha ?? local?.resolvedSha, checks: "unavailable" };
      }
      const checks = await lookupCommitChecks(parsedRepo.data, resolved.resolvedSha, runner);
      return { onMain: true, resolvedSha: resolved.resolvedSha, checks };
    },
  };
}
