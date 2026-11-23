import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { benchmarkPaths } from "./paths.ts";

const root = join(import.meta.dir, "..");

test("default run folders are outside the checkout and results stay in notes", () => {
  const paths = benchmarkPaths(root, tmpdir(), {});
  const fromRoot = relative(root, paths.runs);
  expect(fromRoot.startsWith(".." + sep) || isAbsolute(fromRoot)).toBe(true);
  expect(paths.runs).toBe(join(tmpdir(), "fabric-bench-runs"));
  expect(paths.results).toBe(join(root, "notes/bench/results.jsonl"));
});

test("BENCH_RUNS and BENCH_RESULTS override their defaults", () => {
  const env = { BENCH_RUNS: "/custom/runs", BENCH_RESULTS: "/custom/results.jsonl" };
  expect(benchmarkPaths(root, tmpdir(), env)).toEqual({ runs: env.BENCH_RUNS, results: env.BENCH_RESULTS });
});
