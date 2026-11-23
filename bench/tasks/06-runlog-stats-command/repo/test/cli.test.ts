import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";

async function withLog(fn: (env: Record<string, string>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "runlog-"));
  try {
    await fn({ RUNLOG_FILE: join(dir, "runlog.jsonl") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function collect() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) } };
}

describe("runlog cli", () => {
  test("adds a run and lists it", async () => {
    await withLog(async (env) => {
      const added = collect();
      expect(await run(["add", "deploy", "ok", "1200"], { env, io: added.io })).toBe(0);
      expect(added.out[0]?.startsWith("added ")).toBe(true);

      const listed = collect();
      expect(await run(["list"], { env, io: listed.io })).toBe(0);
      expect(listed.out).toHaveLength(1);
      expect(listed.out[0]).toContain("deploy ok 1200ms");
    });
  });

  test("rejects an unknown status", async () => {
    await withLog(async (env) => {
      const result = collect();
      expect(await run(["add", "deploy", "meh", "1"], { env, io: result.io })).toBe(2);
      expect(result.err.join("\n")).toContain("unknown status");
    });
  });

  test("help lists the commands", async () => {
    const result = collect();
    expect(await run(["help"], { io: result.io })).toBe(0);
    expect(result.out.join("\n")).toContain("list");
    expect(result.out.join("\n")).toContain("add");
  });

  test("an unknown command exits 2", async () => {
    const result = collect();
    expect(await run(["nope"], { io: result.io })).toBe(2);
  });
});
