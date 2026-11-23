import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { dataFile } from "../storage/paths";
import type { Note } from "../types";
import { ValidationError } from "../util/errors";
import { newId } from "../util/ids";

type Env = Record<string, string | undefined>;

async function readNotes(path: string): Promise<Note[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  try {
    const parsed: unknown = JSON.parse(await file.text());
    return Array.isArray(parsed) ? (parsed as Note[]) : [];
  } catch {
    return [];
  }
}

export async function listNotes(projectId: string, env: Env = process.env): Promise<Note[]> {
  const notes = await readNotes(dataFile("notes", env));
  return notes.filter((note) => note.projectId === projectId);
}

export async function addNote(
  input: { projectId: string; body: string },
  env: Env = process.env,
): Promise<Note> {
  const body = input.body.trim();
  if (body.length === 0) throw new ValidationError("note body must not be empty");

  const path = dataFile("notes", env);
  const notes = await readNotes(path);
  const note: Note = {
    id: newId("note"),
    projectId: input.projectId,
    body,
    createdAt: new Date().toISOString(),
  };
  notes.push(note);

  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(notes));
  return note;
}
