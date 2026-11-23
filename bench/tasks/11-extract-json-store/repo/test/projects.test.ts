import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, listProjects } from "../src/services/projects";

async function withData(fn: (env: Record<string, string>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "duo-projects-"));
  try {
    await fn({ DUO_DATA_DIR: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("projects", () => {
  test("starts empty and stores new projects", async () => {
    await withData(async (env) => {
      expect(await listProjects(env)).toEqual([]);
      const project = await createProject({ name: "  Apollo  " }, env);
      expect(project.name).toBe("Apollo");
      const projects = await listProjects(env);
      expect(projects).toHaveLength(1);
      expect(projects[0]?.id).toBe(project.id);
      expect((await readdir(env.DUO_DATA_DIR ?? ".")).sort()).toEqual(["projects.json"]);
    });
  });

  test("rejects an empty name", async () => {
    await withData(async (env) => {
      await expect(createProject({ name: "   " }, env)).rejects.toThrow();
    });
  });
});
