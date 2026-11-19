import { expect, test } from "bun:test";
import { check } from "../../src/kernel/check.ts";
import { run } from "../../src/kernel/host.ts";
import { MAX_RESULT_CHARS, bound, format } from "../../src/kernel/result.ts";
import { TOOLS } from "../../src/providers/tools/index.ts";
import { guestTypes } from "../../src/registry/generate.ts";

// The declarations the checker serves come from the actions (test/registry/generate.test.ts).
const declarations = guestTypes(TOOLS);

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
  expect(check('print("x");', declarations)).toEqual({ ok: true, errors: [] });
  const thenable = check('const fallback: unknown = 0; return π.mode === "bad" ? { then() {} } : fallback;', declarations);
  expect(thenable.ok).toBe(false);
  expect(thenable.errors[0]).toStartWith("line 1:");
});
