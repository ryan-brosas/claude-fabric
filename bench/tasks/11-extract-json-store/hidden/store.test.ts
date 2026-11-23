import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addNote, listNotes } from "../../src/services/notes";
import { createProject, listProjects } from "../../src/services/projects";
import { readJson, writeJson } from "../../src/storage/json-store";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "duo-hidden-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("the shared store", () => {
  test("readJson falls back for a missing file", async () => {
    await withDir(async (dir) => {
      expect(await readJson(join(dir, "missing.json"), { empty: true })).toEqual({ empty: true });
    });
  });

  test("readJson falls back for a corrupt file", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "broken.json");
      await Bun.write(path, "{ not json");
      expect(await readJson(path, [])).toEqual([]);
    });
  });

  test("writeJson creates the directory and leaves no temp file", async () => {
    await withDir(async (dir) => {
      const nested = join(dir, "nested", "deep");
      const path = join(nested, "data.json");
      await writeJson(path, { ok: true });
      expect(await readJson(path, null)).toEqual({ ok: true });
      expect((await readdir(nested)).sort()).toEqual(["data.json"]);
    });
  });

  test("concurrent writes keep the file valid and tidy", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "data.json");
      await Promise.all(
        Array.from({ length: 25 }, (_, index) => writeJson(path, { index })),
      );
      const value = await readJson<{ index: number } | null>(path, null);
      expect(value).not.toBeNull();
      expect(Number.isInteger(value?.index)).toBe(true);
      expect((await readdir(dir)).sort()).toEqual(["data.json"]);
    });
  });
});

describe("the services use the store", () => {
  test("projects and notes still persist, without temp files", async () => {
    await withDir(async (dir) => {
      const env = { DUO_DATA_DIR: dir };
      const first = await createProject({ name: "Apollo" }, env);
      await createProject({ name: "Gemini" }, env);
      expect((await listProjects(env)).map((project) => project.name)).toEqual(["Apollo", "Gemini"]);

      await addNote({ projectId: first.id, body: "kickoff" }, env);
      expect((await listNotes(first.id, env)).map((note) => note.body)).toEqual(["kickoff"]);
      expect((await readdir(dir)).sort()).toEqual(["notes.json", "projects.json"]);
    });
  });

  test("a corrupt projects file still reads as empty", async () => {
    await withDir(async (dir) => {
      await Bun.write(join(dir, "projects.json"), "nonsense");
      expect(await listProjects({ DUO_DATA_DIR: dir })).toEqual([]);
    });
  });

  test("validation still throws", async () => {
    await withDir(async (dir) => {
      const env = { DUO_DATA_DIR: dir };
      await expect(createProject({ name: "  " }, env)).rejects.toThrow();
      await expect(addNote({ projectId: "p", body: "  " }, env)).rejects.toThrow();
    });
  });
});
