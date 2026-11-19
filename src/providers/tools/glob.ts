import { relative, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { defineAction } from "../../registry/action.ts";

const MAX_FILES = 1000;

export const Glob = defineAction({
  name: "Glob",
  doc: "Files matching a glob, newest first, relative to the project.",
  input: z.object({
    pattern: z.string().min(1).describe("Glob pattern, like src/**/*.ts."),
    path: z.string().optional().describe("Directory to search from."),
  }),
  output: z.array(z.string()),
  positional: ["pattern"],
  run: async (i, { cwd }) => {
    const base = resolve(cwd, String(i.path ?? "."));
    const found: string[] = [];
    for await (const f of new Bun.Glob(i.pattern).scan({ cwd: base, onlyFiles: true })) {
      if (!f.split("/").includes("node_modules") && !f.startsWith(".git/")) found.push(f);
    }
    const withTime = await Promise.all(found.map(async (f) => ({ f, t: (await stat(resolve(base, f))).mtimeMs })));
    return withTime.sort((a, b) => b.t - a.t).slice(0, MAX_FILES).map(({ f }) => relative(cwd, resolve(base, f)));
  },
});
