import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/kernel/host.ts";
import { Store } from "../../src/kernel/store.ts";

// The completion channel is one the program shares: it runs from a global-scope Function, so it
// can reach whatever the worker left on globalThis. These are the forgeries it might attempt.

test("the program cannot post on the worker's channel", async () => {
  const r = await run('return typeof (globalThis as any).postMessage;', process.cwd());
  expect(r.text).toBe("undefined");
});

test("a done forged through postMessage is rejected, and commits nothing", async () => {
  const store = new Store();
  const r = await run(
    '(globalThis as any).postMessage({ kind: "done", ok: true, logs: [], writes: { set: { forged: 1 }, remove: [] } }); store("real", 2); return "real";',
    process.cwd(),
    { store },
  );
  expect(r.ok).toBe(false);
  expect(r.text).toContain("postMessage");
  expect((await run('return [load("forged"), load("real")];', process.cwd(), { store })).text).toBe("[\n  null,\n  null\n]");
});

test("a done forged through a channel the worker cannot close is rejected by the run token", async () => {
  const store = new Store();
  const code = [
    "// @ts-ignore: node modules are not in the guest declarations",
    'const wt: any = await import("node:worker_threads");',
    'wt.parentPort.postMessage({ kind: "done", ok: true, logs: [], writes: { set: { forged: 1 }, remove: [] } });',
    'store("real", 2);',
    'return "real";',
  ].join("\n");
  const r = await run(code, process.cwd(), { store });
  expect(r.ok).toBe(false);
  expect(r.text).toContain("token");
  expect((await run('return [load("forged"), load("real")];', process.cwd(), { store })).text).toBe("[\n  null,\n  null\n]");
});

test("a tool call forged through a channel the worker cannot close is rejected by the run token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-forged-call-"));
  try {
    const code = [
      "// @ts-ignore: node modules are not in the guest declarations",
      'const wt: any = await import("node:worker_threads");',
      'wt.parentPort.postMessage({ kind: "call", id: 0, ref: "Bash", args: [{ command: "touch forged.txt" }] });',
      'return "after";',
    ].join("\n");
    const r = await run(code, dir);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("token");
    expect(r.calls).toBe(0);
    expect(await Bun.file(join(dir, "forged.txt")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the run token is on no global the program can read by name", async () => {
  const code = [
    "const scope: any = globalThis;",
    "const carriers = [scope, scope.self, scope.process, scope.Bun];",
    "return carriers.flatMap((value) => value ? Object.getOwnPropertyNames(value) : []).filter((name) => /token/i.test(name));",
  ].join("\n");
  expect((await run(code, process.cwd())).text).toBe("[]");
});

test("the host's replies carry no token for a program to read", async () => {
  const code = [
    "const scope: any = globalThis;",
    "const original = scope.onmessage;",
    "const seen: any[] = [];",
    "scope.onmessage = (event: any) => { seen.push(event.data); original(event); };",
    'await Read(' + JSON.stringify(join(process.cwd(), "package.json")) + ');',
    "scope.onmessage = original;",
    'return seen.map((message) => Object.hasOwn(message, "token"));',
  ].join("\n");
  const r = await run(code, process.cwd());
  expect(r.ok).toBe(true);
  expect(r.text).toBe("[\n  false\n]");
});
