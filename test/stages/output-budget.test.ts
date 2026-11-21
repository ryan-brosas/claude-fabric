import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_RESULT_CHARS, bound } from "../../src/kernel/result.ts";
import { bodyBudget, cutMiddle, outputBudget, savedLine } from "../../src/stages/output-budget.ts";

const fallback = (text: string, max: number): string => text.slice(0, max) + "\n[result cut at " + max + " chars]";

test("bodyBudget is the cap minus the saved-to line, with a floor of one char", () => {
  expect(bodyBudget(1000, 40)).toBe(960);
  expect(bodyBudget(100, 10)).toBe(90);
  expect(bodyBudget(10, 63)).toBe(1);
});

test("leaves a result that fits alone, without writing anything", async () => {
  let wrote = false;
  const text = await outputBudget({
    text: "small",
    max: 1000,
    fallback,
    write: async () => { wrote = true; return "/tmp/x"; },
  });
  expect(text).toBe("small");
  expect(wrote).toBe(false);
});

test("cuts the middle out and names the file that holds it all", async () => {
  const full = "start-" + "x".repeat(4000) + "-end";
  let written = "";
  const text = await outputBudget({
    text: full,
    max: 1000,
    fallback,
    write: async (content) => { written = content; return "/tmp/fabric-result-1/result.txt"; },
  });
  expect(text.length).toBeLessThanOrEqual(1000);
  expect(text).toStartWith("start-");
  expect(text).toEndWith("[Full result (4010 chars) saved to: /tmp/fabric-result-1/result.txt]");
  expect(text).toContain("chars cut from the middle");
  expect(written).toBe(full);
});

test("never cuts the path when the cap barely fits the line", async () => {
  const text = await outputBudget({
    text: "x".repeat(4000),
    max: 100,
    fallback,
    write: async () => "/tmp/fabric-result-1/result.txt",
  });
  expect(text.length).toBeLessThanOrEqual(100);
  expect(text).toContain("/tmp/fabric-result-1/result.txt");
});

test("stays within a cap smaller than the saved-to line", async () => {
  const text = await outputBudget({
    text: "x".repeat(4000),
    max: 5,
    fallback,
    write: async () => "/tmp/fabric-result-1/result.txt",
  });
  expect(text.length).toBeLessThanOrEqual(5);
});

// Finding from review: the injected fallback appends its own marker past the cap, so the stage
// has to bound the fallback result itself.
test("stays within the cap when the file cannot be written", async () => {
  const full = "x".repeat(4000);
  const text = await outputBudget({
    text: full,
    max: 1000,
    fallback,
    write: async () => { throw new Error("disk full"); },
  });
  expect(fallback(full, 1000).length).toBeGreaterThan(1000);
  expect(text.length).toBeLessThanOrEqual(1000);
  expect(text).toContain("chars cut from the middle");
});

test("the fallback stays under the real result cap, not 28 chars over it", async () => {
  const full = "y".repeat(100_000);
  const text = await outputBudget({
    text: full,
    max: MAX_RESULT_CHARS,
    fallback: bound,
    write: async () => { throw new Error("disk full"); },
  });
  expect(bound(full, MAX_RESULT_CHARS).length).toBe(MAX_RESULT_CHARS + 28);
  expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
});

test("a failed save still tells the model to use top-level Read without claiming a saved file", async () => {
  const text = await outputBudget({
    text: "start-" + "x".repeat(31_000) + "-end",
    max: MAX_RESULT_CHARS,
    fallback: bound,
    write: async () => { throw new Error("disk full"); },
  });
  expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  expect(text.includes("Top-level Read returns full files; call it, not programs.")).toBe(true);
  expect(text).toContain("chars cut from the middle");
  expect(text).not.toContain("saved to:");
});

test("a fallback that fits beside the hint stays whole", async () => {
  const text = await outputBudget({
    text: "x".repeat(31_000),
    max: MAX_RESULT_CHARS,
    fallback: () => "short fallback",
    write: async () => { throw new Error("disk full"); },
  });
  expect(text).toBe("short fallback\nTop-level Read returns full files; call it, not programs.");
});

test("a long saved path and the Read hint both fit under the real result cap", async () => {
  const path = "/tmp/" + "p".repeat(10_000) + "/result.txt";
  const text = await outputBudget({
    text: "x".repeat(31_000),
    max: MAX_RESULT_CHARS,
    fallback: bound,
    write: async () => path,
  });
  expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  expect(text.includes("Top-level Read returns full files; call it, not programs.")).toBe(true);
  expect(text.endsWith(path + "]")).toBe(true);
});

test("writes a private file under CLAUDE_PLUGIN_DATA holding the whole result", async () => {
  const base = await mkdtemp(join(tmpdir(), "fabric-data-"));
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = base;
  try {
    const full = "start-" + "x".repeat(4000) + "-end";
    const text = await outputBudget({ text: full, max: 500, fallback });
    const saved = /saved to: (.+)\]$/.exec(text);
    expect(saved).not.toBeNull();
    const file = String(saved?.[1]);
    expect(file.startsWith(base)).toBe(true);
    expect(await Bun.file(file).text()).toBe(full);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
    await rm(base, { recursive: true, force: true });
  }
});

test("cutMiddle is never longer than the cap", () => {
  for (const max of [1, 5, 20, 100, 1000]) expect(cutMiddle("y".repeat(5000), max).length).toBeLessThanOrEqual(max);
  expect(cutMiddle("short", 100)).toBe("short");
  expect(savedLine(12, "/p")).toBe("\n[Full result (12 chars) saved to: /p]");
});
