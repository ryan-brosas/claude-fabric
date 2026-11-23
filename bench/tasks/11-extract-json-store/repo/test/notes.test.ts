import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addNote, listNotes } from "../src/services/notes";

async function withData(fn: (env: Record<string, string>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "duo-notes-"));
  try {
    await fn({ DUO_DATA_DIR: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("notes", () => {
  test("adds notes and lists them by project", async () => {
    await withData(async (env) => {
      expect(await listNotes("prj_1", env)).toEqual([]);
      await addNote({ projectId: "prj_1", body: " first " }, env);
      await addNote({ projectId: "prj_2", body: "other" }, env);
      const notes = await listNotes("prj_1", env);
      expect(notes).toHaveLength(1);
      expect(notes[0]?.body).toBe("first");
      expect(await listNotes("prj_2", env)).toHaveLength(1);
    });
  });

  test("rejects an empty body", async () => {
    await withData(async (env) => {
      await expect(addNote({ projectId: "p", body: "  " }, env)).rejects.toThrow();
    });
  });
});
