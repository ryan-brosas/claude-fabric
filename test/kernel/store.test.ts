import { expect, test } from "bun:test";
import { run } from "../../src/kernel/host.ts";
import { Store } from "../../src/kernel/store.ts";
import { TOTAL_LIMIT, VALUE_LIMIT } from "../../src/stages/store.ts";

// The store is the session's: one per server process. These runs share one, the way one session does.

test("store then load in a later run returns the value, with no tool call between them", async () => {
  const store = new Store();
  const saved = await run('store("answer", { value: 42 }); return "saved";', process.cwd(), { store });
  expect(saved).toMatchObject({ ok: true, text: "saved", calls: 0 });
  const loaded = await run('return load("answer");', process.cwd(), { store });
  expect(loaded.text).toBe('{\n  "value": 42\n}');
  // Nothing crosses the bridge for store or load: they are globals, not tools.
  expect(loaded.calls).toBe(0);
});

test("load of a key nobody stored is undefined, and stays undefined after other keys", async () => {
  const store = new Store();
  await run('store("a", 1);', process.cwd(), { store });
  expect((await run('return load("missing");', process.cwd(), { store })).text).toBe("undefined");
  expect((await run('store("b", 2); return load("b");', process.cwd(), { store })).text).toBe("2");
});

test("load returns a copy, so a program cannot change the store through it", async () => {
  const store = new Store();
  await run('store("list", [1, 2]);', process.cwd(), { store });
  const mutated = await run('const list = load<number[]>("list")!; list.push(3); return load("list");', process.cwd(), { store });
  expect(mutated.text).toBe("[\n  1,\n  2\n]");
});

test("a program that fails commits nothing", async () => {
  const store = new Store();
  await run('store("kept", 1);', process.cwd(), { store });
  const failed = await run('store("kept", 2); store("new", 3); throw new Error("boom");', process.cwd(), { store });
  expect(failed.ok).toBe(false);
  expect(failed.text).toContain("boom");
  expect((await run('return [load("kept"), load("new")];', process.cwd(), { store })).text).toBe("[\n  1,\n  null\n]");
});

test("a program that times out commits nothing", async () => {
  const store = new Store();
  await run('store("kept", 1);', process.cwd(), { store });
  const hung = 'store("kept", 2); await new Promise(() => {});';
  await expect(run(hung, process.cwd(), { store, timeoutMs: 100 })).rejects.toThrow("timed out");
  expect((await run('return load("kept");', process.cwd(), { store })).text).toBe("1");
});

test("a value over its limit fails the program, naming the key and the limit, and commits nothing", async () => {
  const store = new Store();
  await run('store("kept", 1);', process.cwd(), { store });
  const big = await run('store("huge", "x".repeat(' + (VALUE_LIMIT + 1) + '));', process.cwd(), { store });
  expect(big.ok).toBe(false);
  expect(big.text).toContain('"huge"');
  expect(big.text).toContain(String(VALUE_LIMIT));
  expect((await run('return [load("kept"), load("huge")];', process.cwd(), { store })).text).toBe("[\n  1,\n  null\n]");
});

test("a refusal the program catches leaves the store as it was", async () => {
  const store = new Store();
  await run('store("kept", 1);', process.cwd(), { store });
  const caught = await run(
    'try { store("huge", "x".repeat(' + (VALUE_LIMIT + 1) + ')); } catch (error) { print((error as Error).message); } return load("kept");',
    process.cwd(),
    { store },
  );
  expect(caught.ok).toBe(true);
  expect(caught.text).toContain('store: the value for "huge"');
  expect(caught.text.endsWith("1")).toBe(true);
  expect((await run('return [load("kept"), load("huge")];', process.cwd(), { store })).text).toBe("[\n  1,\n  null\n]");
});

test("a store over its total limit fails the program, naming the key and the limit, and commits nothing", async () => {
  const store = new Store();
  // 200002 JSON chars each: the sixth write passes 1048576.
  const code = 'for (let i = 0; i < 6; i++) store("k" + i, "x".repeat(200000));';
  const full = await run(code, process.cwd(), { store });
  expect(full.ok).toBe(false);
  expect(full.text).toContain('"k5"');
  expect(full.text).toContain(String(TOTAL_LIMIT));
  expect((await run('return [load("k0"), load("k5")];', process.cwd(), { store })).text).toBe("[\n  null,\n  null\n]");
});

test("a value of exactly the value limit commits; one char more is refused", async () => {
  const store = new Store();
  // JSON adds the quotes: 262142 characters of text are exactly VALUE_LIMIT JSON chars.
  const exact = "x".repeat(VALUE_LIMIT - 2);
  expect((await run('store("exact", "x".repeat(' + (VALUE_LIMIT - 2) + ')); return "ok";', process.cwd(), { store })).text).toBe("ok");
  expect((await run('return load<string>("exact")!.length;', process.cwd(), { store })).text).toBe(String(exact.length));
  const over = await run('store("over", "x".repeat(' + (VALUE_LIMIT - 1) + '));', process.cwd(), { store });
  expect(over.ok).toBe(false);
  expect(over.text).toContain('"over"');
  expect(over.text).toContain(String(VALUE_LIMIT));
  expect((await run('return [load("over"), load<string>("exact")!.length];', process.cwd(), { store })).text).toBe("[\n  null,\n  " + exact.length + "\n]");
});

test("a store of exactly the total limit commits; one char more is refused", async () => {
  const store = new Store();
  // Four values of exactly VALUE_LIMIT JSON chars: exactly TOTAL_LIMIT, all accepted.
  const code = 'for (let i = 0; i < 4; i++) store("k" + i, "x".repeat(' + (VALUE_LIMIT - 2) + ')); return "ok";';
  expect((await run(code, process.cwd(), { store })).text).toBe("ok");
  const over = await run('store("over", 0);', process.cwd(), { store });
  expect(over.ok).toBe(false);
  expect(over.text).toContain('"over"');
  expect(over.text).toContain(String(TOTAL_LIMIT));
  // The refused write commits nothing: the four values at the cap are still there.
  expect((await run('return ["k0", "k1", "k2", "k3", "over"].map((key) => load(key) === undefined ? 0 : 1);', process.cwd(), { store })).text)
    .toBe("[\n  1,\n  1,\n  1,\n  1,\n  0\n]");
});

test("a program that throws an empty error commits nothing", async () => {
  const store = new Store();
  const failed = await run('store("empty", 1); throw new Error("");', process.cwd(), { store });
  expect(failed.ok).toBe(false);
  expect(failed.text).toBe("Error: ");
  expect((await run('return load("empty");', process.cwd(), { store })).text).toBe("undefined");
});

test("a result that cannot be formatted commits nothing", async () => {
  const store = new Store();
  const bad = await run('store("big", 1); return 1n;', process.cwd(), { store });
  expect(bad.ok).toBe(false);
  expect(bad.text).toContain("could not be formatted");
  expect((await run('return load("big");', process.cwd(), { store })).text).toBe("undefined");
});

test("two overlapping runs that write different keys both keep their keys", async () => {
  const store = new Store();
  // The slow run commits second, from a snapshot that does not hold the fast run's key.
  const slow = 'store("slow", 1); await new Promise<void>((done) => (globalThis as any).setTimeout(done, 100)); return "slow";';
  const fast = 'store("fast", 2); return "fast";';
  const [late, early] = await Promise.all([run(slow, process.cwd(), { store }), run(fast, process.cwd(), { store })]);
  expect(early.text).toBe("fast");
  expect(late.text).toBe("slow");
  expect((await run('return [load("slow"), load("fast")];', process.cwd(), { store })).text).toBe("[\n  1,\n  2\n]");
});

test("a commit that would pass the total limit on the current store fails and writes nothing", async () => {
  const store = new Store();
  // The slow run stages four values that exactly fill an empty store; the fast run commits first.
  const slow = 'for (let i = 0; i < 4; i++) store("k" + i, "x".repeat(' + (VALUE_LIMIT - 2) + ')); await new Promise<void>((done) => (globalThis as any).setTimeout(done, 100)); return "slow";';
  const fast = 'store("kept", 1); return "fast";';
  const [late, early] = await Promise.all([run(slow, process.cwd(), { store }), run(fast, process.cwd(), { store })]);
  expect(early.text).toBe("fast");
  expect(late.ok).toBe(false);
  expect(late.text).toContain(String(TOTAL_LIMIT));
  expect((await run('return [load("kept"), load("k0")];', process.cwd(), { store })).text).toBe("[\n  1,\n  null\n]");
});

test("a key a later run removes is gone for the runs after it", async () => {
  const store = new Store();
  await run('store("gone", 1);', process.cwd(), { store });
  expect((await run('store("gone", undefined); return "removed";', process.cwd(), { store })).text).toBe("removed");
  expect((await run('return load("gone");', process.cwd(), { store })).text).toBe("undefined");
});

test("a value that is not JSON fails the program at the store() call", async () => {
  const store = new Store();
  const r = await run('store("fn", () => 1);', process.cwd(), { store });
  expect(r.ok).toBe(false);
  expect(r.text).toContain('store: the value for "fn" is not JSON');
  expect((await run('return load("fn");', process.cwd(), { store })).text).toBe("undefined");
});

test("store and load are checked like any other global", async () => {
  const typed = await run('const n: string = load<number>("n") ?? 0; return n;', process.cwd());
  expect(typed.ok).toBe(false);
  expect(typed.text.startsWith("Type errors; code was not executed:")).toBe(true);
  expect(typed.calls).toBe(0);
});

test("a value with toJSON is serialized once, and the committed value is the one load returned", async () => {
  const store = new Store();
  // One serialization: the value reads 1, load reads 1, and the store commits 1.
  const r = await run('let n = 0; store("x", { toJSON: () => ++n }); return [load("x"), n];', process.cwd(), { store });
  expect(r.ok).toBe(true);
  expect(r.text).toBe("[\n  1,\n  1\n]");
  expect((await run('return load("x");', process.cwd(), { store })).text).toBe("1");
});

test("a value is not serialized a second time after the store accepted it", async () => {
  const store = new Store();
  // A second read would throw after the write was accepted, leaving a caught refusal with the
  // value staged locally and nothing committed.
  const code = [
    "let reads = 0;",
    'const value = { toJSON: () => { reads++; if (reads > 1) throw new Error("read twice"); return 1; } };',
    'try { store("x", value); } catch (error) { print("refused: " + (error as Error).message); }',
    'return [load("x"), reads];',
  ].join("\n");
  const r = await run(code, process.cwd(), { store });
  expect(r.ok).toBe(true);
  expect(r.text).toBe("[\n  1,\n  1\n]");
  expect((await run('return load("x");', process.cwd(), { store })).text).toBe("1");
});
