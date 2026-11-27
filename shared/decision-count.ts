import type { Note, SessionRow } from "./contract";
import { trackedCoverage, pullKey, type TrackedDecisionView } from "./tracked-decisions";
import type { PullRequestView } from "./prs";

export function activeSessionNote(
  session: Pick<SessionRow, "evidenceId" | "agentNoteSuperseded">,
  note: Note | undefined,
): Note | undefined {
  if (!note) return undefined;
  if (
    session.agentNoteSuperseded &&
    note.origin === "agent" &&
    note.kind !== "clear" &&
    note.evidenceId &&
    (!session.evidenceId || note.evidenceId !== session.evidenceId)
  ) {
    return undefined;
  }
  return note;
}

export function displayLane(session: SessionRow, note: Note | undefined): SessionRow["lane"] | "done" {
  const activeNote = activeSessionNote(session, note);
  if (session.nativePending) return "human";
  if (session.evidenceId && session.evidenceId === activeNote?.evidenceId && activeNote.origin === "person") {
    if (activeNote.kind === "done") return "done";
    if (activeNote.kind === "review") return "review";
    if (activeNote.kind === "clear" && session.lane === "human") return "idle";
  }
  if (session.decisionAnswered) {
    return session.lane === "running" || session.lane === "unknown" ? session.lane : "review";
  }
  if (session.lane === "human" || activeNote?.kind === "question") return "human";
  if (session.lane === "running") return "running";
  if (session.lane === "review" || activeNote?.kind === "review" || (activeNote?.kind === "done" && activeNote.origin === "agent")) return "review";
  if (activeNote?.kind === "done") return "done";
  return session.lane;
}

export function decisionCount(view: {sessions: SessionRow[]; notes: Record<string, Note>; pullRequests?: PullRequestView; trackedDecisions?: TrackedDecisionView}) {
  const sessions = view.sessions.filter(row => displayLane(row, view.notes[row.id]) === "human");
  const records = view.trackedDecisions?.items ?? [];
  const covered = trackedCoverage(records);
  return records.length + sessions.filter(s => !covered.sessionIds.has(s.id)).length +
    (view.pullRequests?.items.filter(pr => pr.lane === "review" && !covered.pullKeys.has(pullKey(pr.repo, pr.number))).length ?? 0);
}
