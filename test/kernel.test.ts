import { expect, test } from "bun:test";
import { TOOL_NAMES } from "../kernel/protocol.ts";
import { check } from "../kernel/check.ts";
import { run } from "../kernel/host.ts";
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

test("a worker crash outside the protocol reports the real error at once, bounded", async () => {
  const crash = (message: string) => `return await new Promise<never>(() => { (globalThis as any).setTimeout(() => { throw new Error(${message}); }, 0); });`;
  const started = performance.now();
  const small = await run(crash('"boom outside"'), process.cwd(), { timeoutMs: 3_000 });
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(small.ok).toBe(false);
  expect(small.text).toContain("boom outside");
  const big = await run(crash('"x".repeat(100_000)'), process.cwd(), { timeoutMs: 3_000 });
  expect(big.ok).toBe(false);
  expect(big.text.endsWith(`[result cut at ${MAX_RESULT_CHARS} chars]`)).toBe(true);
});

test("a program may end without return, but every return is still checked", () => {
  expect(check('print("x");')).toEqual({ ok: true, errors: [] });
  const thenable = check('const fallback: unknown = 0; return π.mode === "bad" ? { then() {} } : fallback;');
  expect(thenable.ok).toBe(false);
  expect(thenable.errors[0]).toStartWith("line 1:");
});
