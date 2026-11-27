import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { noteSchema, saveNote, type Note } from "../shared/contract";

const stored = z.object({ version: z.literal(1), notes: z.array(noteSchema) });
type Change = z.infer<typeof saveNote.input>;

// One plugin worker owns this file on each daemon. Keep compare/write synchronous so
// two clients editing the same card cannot both commit against one revision.
export class NoteStore {
  constructor(private readonly path: string) {}

  private read(): Map<string, Note> {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    const data = stored.parse(JSON.parse(text));
    return new Map(data.notes.map(note => [note.sessionId, note]));
  }

  visible(sessionIds: Set<string>): Record<string, Note> {
    return Object.fromEntries([...this.read()].filter(([id]) => sessionIds.has(id)));
  }

  update(change: Change, origin: "person" | "agent" = "person", questionCursor?: string) {
    const notes = this.read();
    const previous = notes.get(change.sessionId);
    if ((previous?.revision ?? 0) !== change.expectedRevision) return { ok: false, conflict: true };
    const text = change.kind === "clear" ? "" : change.text;
    if (previous?.kind === change.kind && previous.text === text && previous.origin === origin && previous.evidenceId === change.evidenceId) return { ok: true, conflict: false };
    notes.set(change.sessionId, {
      ...(change.kind === "question" ? {requestedAt: new Date().toISOString()} : {}),
      ...(questionCursor ? {questionCursor} : {}),
      sessionId: change.sessionId, kind: change.kind, text, origin, ...(change.evidenceId ? { evidenceId: change.evidenceId } : {}), revision: change.expectedRevision + 1,
    });
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, notes: [...notes.values()] }), {
        flag: "wx", mode: 0o600,
      });
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
    return { ok: true, conflict: false };
  }
}
