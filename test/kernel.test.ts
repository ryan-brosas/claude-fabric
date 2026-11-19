import { expect, test } from "bun:test";
import { TOOL_NAMES } from "../kernel/protocol.ts";
import { execute } from "../kernel/execute.ts";
import { MAX_RESULT_CHARS, bound, format } from "../kernel/result.ts";

const guest = new URL("../kernel/guest.d.ts", import.meta.url).pathname;

test("guest.d.ts declares exactly the program tools, and print", async () => {
  const text = await Bun.file(guest).text();
  const declared = new Set([...text.matchAll(/declare function (\w+)/g)].map((m) => m[1]));
  expect([...declared].sort()).toEqual([...TOOL_NAMES, "print"].sort());
});

test("format returns a string value as is", () => {
  expect(format({ kind: "done", value: "hi", logs: [] })).toBe("hi");
});

test("format pretty-prints an object value", () => {
  expect(format({ kind: "done", value: { a: 1 }, logs: [] })).toBe('{\n  "a": 1\n}');
});

test("format names a missing value", () => {
  expect(format({ kind: "done", value: undefined, logs: [] })).toBe("undefined");
});

test("format reports an error and ignores a value beside it", () => {
  expect(format({ kind: "done", error: "boom", value: "ignored", logs: [] })).toBe("Error: boom");
});

test("format puts logs before the body, in call order", () => {
  expect(format({ kind: "done", value: 2, logs: ["first", "second"] })).toBe("first\nsecond\n2");
});

test("bound leaves text at the cap alone", () => {
  const text = "x".repeat(MAX_RESULT_CHARS);
  expect(bound(text, MAX_RESULT_CHARS)).toBe(text);
});

test("bound cuts one char over the cap and says so", () => {
  const text = "x".repeat(MAX_RESULT_CHARS + 1);
  expect(bound(text, MAX_RESULT_CHARS)).toBe("x".repeat(MAX_RESULT_CHARS) + `\n[result cut at ${MAX_RESULT_CHARS} chars]`);
});

test("a worker crash outside the protocol reports the real error, not a timeout", async () => {
  const code = 'await new Promise(() => { (globalThis as any).setTimeout(() => { throw new Error("boom outside"); }, 0); });';
  const started = performance.now();
  await expect(execute(code, process.cwd(), { timeoutMs: 3_000 })).rejects.toThrow("boom outside");
  expect(performance.now() - started).toBeLessThan(2_000);
});
