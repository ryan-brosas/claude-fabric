import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli";

const RUNS = [
  { id: "run_1", task: "deploy", status: "ok", durationMs: 5000, startedAt: "2026-01-01T00:00:00.000Z" },
  { id: "run_2", task: "build", status: "failed", durationMs: 1000, startedAt: "2026-01-01T00:01:00.000Z" },
  { id: "run_3", task: "lint", status: "ok", durationMs: 300, startedAt: "2026-01-01T00:02:00.000Z" },
  { id: "run_4", task: "test", status: "skipped", durationMs: 0, startedAt: "2026-01-01T00:03:00.000Z" },
  { id: "run_5", task: "build", status: "ok", durationMs: 2200, startedAt: "2026-01-01T00:04:00.000Z" },
];

async function withLog(
  seed: typeof RUNS | null,
  fn: (env: Record<string, string>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "runlog-hidden-"));
  const path = join(dir, "runlog.jsonl");
  if (seed) await Bun.write(path, seed.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  try {
    await fn({ RUNLOG_FILE: path });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function collect() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) } };
}

describe("stats command", () => {
  test("prints the summary lines", async () => {
    await withLog(RUNS, async (env) => {
      const result = collect();
      expect(await run(["stats"], { env, io: result.io })).toBe(0);
      expect(result.out).toEqual([
        "total: 5",
        "ok: 3",
        "failed: 1",
        "skipped: 1",
        "avg: 1700ms",
        "slowest: deploy (5000ms)",
      ]);
      expect(result.err).toEqual([]);
    });
  });

  test("prints JSON with --json", async () => {
    await withLog(RUNS, async (env) => {
      const result = collect();
      expect(await run(["stats", "--json"], { env, io: result.io })).toBe(0);
      expect(result.out).toHaveLength(1);
      expect(JSON.parse(result.out[0] ?? "{}")).toEqual({
        total: 5,
        ok: 3,
        failed: 1,
        skipped: 1,
        avgDurationMs: 1700,
        slowest: { task: "deploy", durationMs: 5000 },
      });
    });
  });

  test("an empty log gives zeros", async () => {
    await withLog(null, async (env) => {
      const text = collect();
      expect(await run(["stats"], { env, io: text.io })).toBe(0);
      expect(text.out).toEqual([
        "total: 0",
        "ok: 0",
        "failed: 0",
        "skipped: 0",
        "avg: 0ms",
        "slowest: none",
      ]);

      const json = collect();
      expect(await run(["stats", "--json"], { env, io: json.io })).toBe(0);
      expect(JSON.parse(json.out[0] ?? "{}")).toEqual({
        total: 0,
        ok: 0,
        failed: 0,
        skipped: 0,
        avgDurationMs: 0,
        slowest: null,
      });
    });
  });

  test("help mentions stats and list still works", async () => {
    await withLog(RUNS, async (env) => {
      const help = collect();
      expect(await run(["help"], { env, io: help.io })).toBe(0);
      expect(help.out.join("\n")).toContain("stats");

      const listed = collect();
      expect(await run(["list"], { env, io: listed.io })).toBe(0);
      expect(listed.out).toHaveLength(5);
    });
  });

  test("the average rounds to the nearest millisecond", async () => {
    const runs = [
      { id: "a", task: "one", status: "ok", durationMs: 100, startedAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", task: "two", status: "failed", durationMs: 101, startedAt: "2026-01-01T00:01:00.000Z" },
    ];
    await withLog(runs, async (env) => {
      const result = collect();
      expect(await run(["stats", "--json"], { env, io: result.io })).toBe(0);
      expect(JSON.parse(result.out[0] ?? "{}").avgDurationMs).toBe(101);
    });
  });
});
