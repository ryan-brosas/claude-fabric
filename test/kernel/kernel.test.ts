import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { check } from "../../src/kernel/check.ts";
import { run } from "../../src/kernel/host.ts";
import type { Done } from "../../src/kernel/protocol.ts";
import { MAX_RESULT_CHARS, bound, format } from "../../src/kernel/result.ts";
import { TOOLS } from "../../src/providers/tools/index.ts";
import { guestTypes } from "../../src/registry/generate.ts";
import { BLOCK, RepeatGuard } from "../../src/stages/repeat-guard.ts";

// The declarations the checker serves come from the actions (test/registry/generate.test.ts).
const declarations = guestTypes(TOOLS);

// An oversized result is saved whole in a fresh private directory; a test that makes one removes it.
const savedDirs = (...texts: string[]): string[] =>
  texts.flatMap((text) => {
    const saved = /saved to: (.+)]$/.exec(text);
    return saved ? [dirname(String(saved[1]))] : [];
  });
const removeSaved = async (...texts: string[]): Promise<void> => {
  await Promise.all(savedDirs(...texts).map((dir) => rm(dir, { recursive: true, force: true })));
};

// A done message as a worker sends it, for the formatter's own tests.
const done = (parts: Partial<Done> = {}): Done => ({
  kind: "done", token: "test", ok: true, logs: [], writes: { set: {}, remove: [] }, ...parts,
});

test("format ends at the last print() line when the program returned nothing", () => {
  expect(format(done({ logs: ["one", "two"] }))).toBe("one\ntwo");
  // With no lines either, the result still says nothing came back.
  expect(format(done())).toBe("undefined");
  // A value the program did return is kept, even a null.
  expect(format(done({ logs: ["one"], value: null }))).toBe("one\nnull");
});

test("format returns a string value as is", () => {
  expect(format(done({ value: "hi" }))).toBe("hi");
});

test("format pretty-prints an object value", () => {
  expect(format(done({ value: { a: 1 } }))).toBe('{\n  "a": 1\n}');
});

test("format names a missing value", () => {
  expect(format(done({ value: undefined }))).toBe("undefined");
});

test("format reports an error and ignores a value beside it", () => {
  expect(format(done({ ok: false, error: "boom", value: "ignored" }))).toBe("Error: boom");
});

test("format keeps an empty error a failure", () => {
  expect(format(done({ ok: false, error: "" }))).toBe("Error: ");
});

test("format puts logs before the body, in call order", () => {
  expect(format(done({ value: 2, logs: ["first", "second"] }))).toBe("first\nsecond\n2");
});

test("bound leaves text at the cap alone", () => {
  const text = "x".repeat(MAX_RESULT_CHARS);
  expect(bound(text, MAX_RESULT_CHARS)).toBe(text);
});

test("bound cuts one char over the cap and says so", () => {
  const text = "x".repeat(MAX_RESULT_CHARS + 1);
  expect(bound(text, MAX_RESULT_CHARS)).toBe("x".repeat(MAX_RESULT_CHARS) + `\n[result cut at ${MAX_RESULT_CHARS} chars]`);
});

test("a worker crash outside the protocol reports the real error at once", async () => {
  const crash = (message: string) => `return await new Promise<never>(() => { (globalThis as any).setTimeout(() => { throw new Error(${message}); }, 0); }); `;
  const started = performance.now();
  const small = await run(crash('"boom outside"'), process.cwd(), { timeoutMs: 3_000 });
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(small.ok).toBe(false);
  expect(small.text).toContain("boom outside");
});

// Behavior change in step 4: a result over the cap is kept whole in a private file and cut in the
// middle, instead of being sliced at the cap. The cap itself does not move.
test("a result over the cap ends with the file that holds all of it", async () => {
  const crash = `return await new Promise<never>(() => { (globalThis as any).setTimeout(() => { throw new Error("x".repeat(100_000)); }, 0); }); `;
  const big = await run(crash, process.cwd(), { timeoutMs: 3_000 });
  try {
    expect(big.ok).toBe(false);
    expect(big.text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(big.text).toContain("chars cut from the middle");
    const saved = /\n\[Full result \((\d+) chars\) saved to: (.+)\]$/.exec(big.text);
    expect(saved).not.toBeNull();
    const chars = Number(saved?.[1]);
    const file = String(saved?.[2]);
    expect(chars).toBeGreaterThan(100_000);
    expect((await Bun.file(file).text()).length).toBe(chars);
  } finally {
    await removeSaved(big.text);
  }
});

test("an unquoted path is repaired before the check, and the program runs", async () => {
  const read = await run("return (await Read(" + join(process.cwd(), "package.json") + ")).split('\\n')[0];", process.cwd());
  expect(read.ok).toBe(true);
  expect(read.text).toBe("     1\t{");
  expect(read.calls).toBe(1);
});

// Finding from review: /a.txt/.source is a valid expression (the regex's source string), so
// Read(/a.txt/.source) is a valid program. Repair must not rewrite a program the check accepts.
test("a valid program that looks like an unquoted path is not repaired", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-repair-"));
  await Bun.write(join(dir, "a.txt"), "alpha");
  try {
    const read = await run("return await Read(/a.txt/.source);", dir);
    expect(read.ok).toBe(true);
    expect(read.text).toBe("     1\talpha");
    expect(read.calls).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a type error carries its hint under the check's own lines", async () => {
  const failed = await run('return await Bash({ command: "ls", settle: true });', process.cwd());
  expect(failed.ok).toBe(false);
  expect(failed.calls).toBe(0);
  expect(failed.text.startsWith("Type errors; code was not executed:\nline 1:")).toBe(true);
  expect(failed.text).toContain("Recovery hint: `settle` is not a `Bash` field");
});

test("the session guard warns at three identical runs and blocks the sixth", async () => {
  const guard = new RepeatGuard();
  const first = await run("return 1;", process.cwd(), { guard });
  expect(first).toMatchObject({ ok: true, text: "1", calls: 0 });
  await run("return 1;", process.cwd(), { guard });
  const warned = await run("return 1;", process.cwd(), { guard });
  expect(warned.text.startsWith("1\n[circuit-breaker]")).toBe(true);
  for (let i = 0; i < 2; i++) await run("return 1;", process.cwd(), { guard });
  const blocked = await run("return 1;", process.cwd(), { guard });
  expect(blocked.ok).toBe(false);
  expect(blocked.text).toContain("has now executed 6 times in a row and was blocked");
  expect(blocked.ms.run).toBe(0);
  const other = await run("return 2;", process.cwd(), { guard });
  expect(other.text).toBe("2");
});

test("a program may end without return, but every return is still checked", () => {
  expect(check('print("x");', declarations)).toEqual({ ok: true, errors: [] });
  const thenable = check('const fallback: unknown = 0; return π.mode === "bad" ? { then() {} } : fallback;', declarations);
  expect(thenable.ok).toBe(false);
  expect(thenable.errors[0]).toStartWith("line 1:");
});

test("a warned result over the cap stays within it and keeps the warning", async () => {
  const guard = new RepeatGuard();
  const code = 'return "x".repeat(100_000);';
  const earlier = [await run(code, process.cwd(), { guard }), await run(code, process.cwd(), { guard })];
  const third = await run(code, process.cwd(), { guard });
  try {
    expect(third.text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(third.text).toContain("[circuit-breaker]");
  } finally {
    await removeSaved(...earlier.map((result) => result.text), third.text);
  }
});

// The count and both verdicts are the compiled machine's (src/stages/verified/repeat-guard.ts); a
// blocked call returns before a worker starts, so its side effect never happens.
test("a blocked call runs nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-blocked-"));
  try {
    const guard = new RepeatGuard();
    const code = 'await Bash({ command: "touch ran.txt" }); return "ran";';
    for (let runCount = 0; runCount < BLOCK - 1; runCount++) {
      expect((await run(code, dir, { guard })).calls).toBe(1);
    }
    await rm(join(dir, "ran.txt"), { force: true });
    const blocked = await run(code, dir, { guard });
    expect(blocked).toMatchObject({ ok: false, calls: 0, ms: { run: 0 } });
    expect(blocked.text).toContain("was blocked");
    expect(await Bun.file(join(dir, "ran.txt")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed check with many errors stays within the cap", async () => {
  const code = Array.from({ length: 3000 }, (_, i) => `const v${i}: number = "s";`).join("\n");
  const r = await run(code, process.cwd());
  try {
    expect(r.ok).toBe(false);
    expect(r.text.startsWith("Type errors; code was not executed:")).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  } finally {
    await removeSaved(r.text);
  }
});

// Dogfooding: programs that waited between calls failed the check, since lib.es2023 has no timers.
test("a program may wait with setTimeout and cancel with clearTimeout", async () => {
  const waited = await run(
    "const cancelled = setTimeout(() => print('never'), 5); clearTimeout(cancelled);\n" +
    "await new Promise((resolve) => setTimeout(resolve, 20));\n" +
    "return 'waited';",
    process.cwd(),
  );
  expect(waited.ok).toBe(true);
  expect(waited.text).toBe("waited");
});

test("the timer types stay strict: no handler arguments, and an opaque handle", () => {
  expect(check("setTimeout((value) => value.missing(), 0);", declarations).ok).toBe(false);
  expect(check("const handle = setTimeout(() => {}, 0); return handle + 1;", declarations).ok).toBe(false);
});

test("a timer pending when the program returns never changes the result or makes a tool call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-timer-"));
  try {
    const late = join(dir, "late.txt");
    const result = await run(
      "setTimeout(() => print('late'), 30);\n" +
      "setTimeout(() => { void Write({ file_path: " + JSON.stringify(late) + ", content: 'x' }); }, 30);\n" +
      "return 'early';",
      dir,
    );
    expect(result.ok).toBe(true);
    expect(result.text).toBe("early");
    await Bun.sleep(200);
    expect(await Bun.file(late).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a timer that keeps rescheduling itself ends at the call's time limit", async () => {
  const started = Date.now();
  await expect(run(
    "const tick = (): void => { setTimeout(tick, 1); };\ntick();\nawait new Promise<void>(() => {});",
    process.cwd(),
    { timeoutMs: 500 },
  )).rejects.toThrow("timed out after 500ms");
  expect(Date.now() - started).toBeLessThan(5_000);
});

// A program that timed out used to leave its Bash running until Bash's own timeout.
test("a Bash still running when its program times out is stopped with it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-abort-"));
  try {
    const marker = join(dir, "still-ran.txt");
    await expect(run(
      "await Bash({ command: " + JSON.stringify("sleep 1 && touch " + marker) + " }); return 'done';",
      dir,
      { timeoutMs: 200 },
    )).rejects.toThrow("timed out after 200ms");
    await Bun.sleep(1_500);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Sol on #34: killing bash -c alone leaves what it started. The whole process group stops.
test("a process the command started in the background stops with its program too", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-tree-"));
  try {
    const ready = join(dir, "ready.txt");
    const survived = join(dir, "survived.txt");
    const command = "sh -c " + JSON.stringify("touch " + ready + "; sleep 1; touch " + survived) + " & wait";
    await expect(run(
      "await Bash({ command: " + JSON.stringify(command) + " }); return 'done';",
      dir,
      { timeoutMs: 400 },
    )).rejects.toThrow("timed out after 400ms");
    expect(await Bun.file(ready).exists()).toBe(true);
    await Bun.sleep(1_500);
    expect(await Bun.file(survived).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Bash's own timeout kills the command's children and does not hang on their pipes", async () => {
  const started = Date.now();
  const result = await run("return await Bash({ command: 'sleep 30 & sleep 30; echo never', timeout: 300 });", process.cwd(), { timeoutMs: 10_000 });
  expect(result.ok).toBe(false);
  expect(result.text).toContain("Bash timed out after 300ms");
  expect(Date.now() - started).toBeLessThan(5_000);
});

// Sol on #34: a child the command left in the background, output redirected, escaped cleanup.
test("a child a finished command left in the background stops when its program ends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-bg-"));
  try {
    const survived = join(dir, "survived.txt");
    const command = "(sleep 1; touch " + survived + ") >/dev/null 2>&1 &";
    const result = await run("await Bash({ command: " + JSON.stringify(command) + " }); return 'left';", dir);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("left");
    await Bun.sleep(1_500);
    expect(await Bun.file(survived).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
