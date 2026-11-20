import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MAX_RESULT_CHARS } from "../../src/kernel/result.ts";
import { BRIDGE_HEADER, boundSecret, bridgePaths } from "../../src/bridge/contract.ts";
import { TOOLS } from "../../src/providers/tools/index.ts";

const root = new URL("../..", import.meta.url).pathname;
const TOOL_NAMES = TOOLS.map((action) => action.name);
let client: Client;
let work: string;

beforeAll(async () => {
  // Programs run against a scratch project so write tests never touch the repo.
  work = await mkdtemp(join(tmpdir(), "fabric-test-"));
  await Bun.write(join(work, "a.txt"), "alpha\nbeta\nalpha\n");
  await Bun.write(join(work, "src/one.ts"), "export const one = 1;\n");
  await Bun.write(join(work, "src/two.ts"), "export const two = 2;\n");
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: "bun",
    args: [root + "src/server/index.ts"],
    // No bridge: these tests never touch the plugin's real data folder or a real session.
    env: { ...process.env, CLAUDE_PROJECT_DIR: work, CLAUDE_PLUGIN_DATA: "", CLAUDE_CODE_SESSION_ID: "" } as Record<string, string>,
  }));
});
afterAll(async () => { await client.close(); await rm(work, { recursive: true, force: true }); });

const call = async (args: Record<string, unknown>) => {
  const r = await client.callTool({ name: "fabric_exec", arguments: args });
  return { isError: Boolean(r.isError), text: (r.content as { text: string }[])[0].text };
};

test("lists exactly one tool, fabric_exec, documented with Claude tool names", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toEqual(["fabric_exec"]);
  expect(tools[0].inputSchema.required).toEqual(["code"]);
  for (const name of TOOL_NAMES) expect(tools[0].description).toContain(name + "(");
  expect(tools[0].description).not.toContain("pi.");
  // The mcp surface is one line about the shape, never the session's tool list.
  const description = String(tools[0]?.description ?? "");
  expect(description).toContain("mcp.<server>.<tool>(args)");
  expect(description.split("\n").filter((line) => line.startsWith("- mcp."))).toHaveLength(1);
});

test("history explains when this session has no transcript path", async () => {
  const result = await call({ code: 'return await history.recall({query: "missing"});' });
  expect(result.isError).toBe(true);
  expect(result.text).toContain("transcript path is unknown");
});

test("history calls cross the real server and expand the fixture token", async () => {
  const data = await mkdtemp(join(tmpdir(), "frec-"));
  const session = "history-fixture";
  const paths = bridgePaths(data, session);
  const fixture = join(work, "history.jsonl");
  await Bun.write(fixture, Bun.file(new URL("../recall/fixtures/chain.jsonl", import.meta.url)));
  const other = new Client({ name: "history-test", version: "0.0.0" });
  try {
    await other.connect(new StdioClientTransport({ command: "bun", args: [root + "src/server/index.ts"],
      env: { ...process.env, CLAUDE_PROJECT_DIR: work, CLAUDE_PLUGIN_DATA: data, CLAUDE_CODE_SESSION_ID: session } as Record<string, string> }));
    const started = performance.now();
    while (!(await Bun.file(paths.secret).exists()) && performance.now() - started < 4000) await Bun.sleep(10);
    const secret = boundSecret(await Bun.file(paths.secret).text(), session);
    expect(secret).toBeDefined();
    const post = (value: string) => fetch("http://bridge/session", { method: "POST", unix: paths.socket,
      headers: { [BRIDGE_HEADER]: value, "content-type": "application/json" }, body: JSON.stringify({ transcriptPath: fixture }) });
    expect((await post("wrong-secret")).status).toBe(403);
    expect((await post(secret!)).status).toBe(200);
    const r = await other.callTool({ name: "fabric_exec", arguments: { code: 'const hits = await history.recall({query: "ALMANAC-493"}); const page = await history.expand(hits.hits[0]!.follow); return page.entries[0]!.text;' } });
    expect(r.isError).toBe(false);
    expect((r.content as { text: string }[])[0]!.text).toContain("ALMANAC-493");
    const phrase = await other.callTool({ name: "fabric_exec", arguments: { code: `
      const found = await history.recall({ query: '\"harbor token\"' });
      const reversed = await history.recall({ query: '\"token harbor\"' });
      const page = await history.expand(found.hits[0]!.follow);
      return { ids: found.hits.map(hit => hit.uuid), reversed: reversed.total, text: page.entries[0]!.text };
    ` } });
    expect(phrase.isError).toBe(false);
    expect(JSON.parse((phrase.content as { text: string }[])[0]!.text))
      .toEqual({ ids: ["u1"], reversed: 0, text: "The harbor token is before compaction." });
    const bad = await other.callTool({ name: "fabric_exec", arguments: { code: 'return await history.recall({query: 42 as any});' } });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0]!.text).toContain("query");
  } finally {
    await other.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("Read numbers lines like cat -n and honors offset and limit", async () => {
  expect(await call({ code: 'return await Read({ file_path: "a.txt", offset: 2, limit: 1 });' }))
    .toEqual({ isError: false, text: "     2\tbeta\n[Showing lines 2-2 of 4. Use offset=3 to continue.]" });
});

test("Write then Edit, with the unique-match rule", async () => {
  const r = await call({ code: `
await Write("b.txt", "x = 1\\nx = 1\\n");
const dup = await Edit("b.txt", "x = 1", "x = 2").catch((e: Error) => e.message);
await Edit({ file_path: "b.txt", old_string: "x = 1", new_string: "x = 2", replace_all: true });
return { dup, after: (await Bash("cat b.txt")).output };` });
  expect(r.isError).toBe(false);
  expect(JSON.parse(r.text)).toEqual({ dup: expect.stringContaining("matches 2 times"), after: "x = 2\nx = 2\n" });
});

test("Grep defaults to files_with_matches; content mode gives lines", async () => {
  const r = await call({ code: 'return { files: await Grep("alpha"), lines: await Grep({ pattern: "alpha", output_mode: "content" }) };' });
  expect(JSON.parse(r.text)).toEqual({ files: "a.txt", lines: "a.txt:1:alpha\na.txt:3:alpha" });
});

test("Glob returns matching paths relative to the project", async () => {
  const r = await call({ code: 'return (await Glob("src/*.ts")).sort();' });
  expect(JSON.parse(r.text)).toEqual(["src/one.ts", "src/two.ts"]);
});

test("parallel Bash calls and print output", async () => {
  const r = await call({ code: 'const [a, b] = await Promise.all([Bash("echo one"), Bash("echo two")]); print("both done"); return a.output.trim() + b.output.trim();' });
  expect(r).toEqual({ isError: false, text: "both done\nonetwo" });
});

test("Bash rejects on nonzero exit unless allowFailure", async () => {
  expect((await call({ code: 'return await Bash("exit 4");' })).text).toContain("exited 4");
  const r = await call({ code: 'return (await Bash({ command: "exit 4", allowFailure: true })).exitCode;' });
  expect(r).toEqual({ isError: false, text: "4" });
});

test("type error is reported and nothing runs", async () => {
  const r = await call({ code: 'await Bash("touch should-not-exist"); const n: number = "x"; return n;' });
  expect(r.isError).toBe(true);
  expect(r.text).toContain("line 1:");
  expect(await Bun.file(join(work, "should-not-exist")).exists()).toBe(false);
});

test("payloads arrive as π and a missing key names the provided keys", async () => {
  expect(await call({ code: "return π.note.length;", payloads: { note: "a`b${c}" } })).toEqual({ isError: false, text: "7" });
  const missing = await call({ code: "return π.other;", payloads: { note: "x" } });
  expect(missing.isError).toBe(true);
  expect(missing.text).toContain("Provided keys: note");
});

test("a bad argument is a catchable error naming the tool and the field", async () => {
  const bad = await call({ code: "return await Read({ file_path: 3 as any });" });
  expect(bad.isError).toBe(true);
  expect(bad.text).toContain("Read");
  expect(bad.text).toContain("file_path");
  const caught = await call({ code: "return await Read({} as any).catch((e: Error) => e.message);" });
  expect(caught).toEqual({ isError: false, text: "Read: file_path is required (string)" });
});

test("unknown display keys are accepted", async () => {
  expect(await call({ code: "return 1 + 1;", display: { name: "sum", extra: true } })).toEqual({ isError: false, text: "2" });
});

test("a program without return runs, and its print output comes back", async () => {
  const r = await call({ code: 'print("ran");' });
  expect(r.isError).toBe(false);
  expect(r.text.startsWith("ran")).toBe(true);
});

// The repairs run before the strict check: a model that sends the program as lines, or the payload
// map as JSON text, gets a result instead of a rejected call.
test("payloads sent as a JSON string arrive as π", async () => {
  expect(await call({ code: "return π.note.length;", payloads: JSON.stringify({ note: "a`b${c}" }) }))
    .toEqual({ isError: false, text: "7" });
});

test("a program sent as an array of lines runs", async () => {
  expect(await call({ code: ["const x = 1;", "return x + 1;"] })).toEqual({ isError: false, text: "2" });
});

test("a payload map that is still wrong is a clear error naming the field", async () => {
  const r = await call({ code: "return 1;", payloads: '{"n":1}' });
  expect(r.isError).toBe(true);
  expect(r.text).toBe("fabric_exec: payloads must be an object of strings, like {\"name\": \"text\"}, or a JSON object string.");
});

test("an unquoted path is repaired before the check runs", async () => {
  const r = await call({ code: "return await Read(" + join(work, "a.txt") + ");" });
  expect(r.isError).toBe(false);
  expect(r.text.startsWith("     1\talpha")).toBe(true);
});

test("a failed check keeps its own lines first and adds the hint under them", async () => {
  const r = await call({ code: 'return await Bash({ command: "ls", settle: true });' });
  expect(r.isError).toBe(true);
  expect(r.text.startsWith("Type errors; code was not executed:\nline 1:")).toBe(true);
  expect(r.text).toContain("Recovery hint: `settle` is not a `Bash` field");
});

// Findings from review: the advertised input schema rejected shapes the repairs handle (a bare
// string display, null optional fields), so those repairs could never run over MCP.
test("a display label sent as a bare string is accepted", async () => {
  expect(await call({ code: "return 1 + 1;", display: "sum" })).toEqual({ isError: false, text: "2" });
});

test("null optional fields are absent, not invalid", async () => {
  expect(await call({ code: "return 3;", payloads: null, display: null, strings: null })).toEqual({ isError: false, text: "3" });
});

// Finding from review: an envelope error must not be the way a huge argument reaches the model.
test("an envelope error never echoes a user key and stays within the cap", async () => {
  const huge = "x".repeat(30_000);
  const r = await call({ code: "return 1;", strings: { [huge]: 1 } });
  expect(r.isError).toBe(true);
  expect(r.text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  expect(r.text).toBe('fabric_exec: payloads must be an object of strings, like {"name": "text"}, or a JSON object string.');
});

// The store is the session's, so two calls share it. Nothing crosses the bridge for store or load.
test("two fabric_exec calls share the session's store", async () => {
  expect(await call({ code: 'store("kept", { n: 1 }); return "saved";' })).toEqual({ isError: false, text: "saved" });
  expect(await call({ code: 'return load<{ n: number }>("kept");' })).toEqual({ isError: false, text: '{\n  "n": 1\n}' });
});

test("a failed program leaves the session's store as it was", async () => {
  await call({ code: 'store("stable", 1); return "saved";' });
  const failed = await call({ code: 'store("stable", 2); throw new Error("boom");' });
  expect(failed.isError).toBe(true);
  expect(await call({ code: 'return load("stable");' })).toEqual({ isError: false, text: "1" });
});

test("one guard per server process warns at three identical calls and blocks the sixth", async () => {
  const code = 'return "repeat-guard";';
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) seen.push((await call({ code })).text);
  expect(seen.slice(0, 2)).toEqual(["repeat-guard", "repeat-guard"]);
  for (const text of seen.slice(2, 5)) {
    expect(text.startsWith("repeat-guard\n[circuit-breaker]")).toBe(true);
    expect(text).toContain("at 6 identical runs will be blocked");
  }
  expect(seen[5]).toContain("has now executed 6 times in a row and was blocked");
  expect(await call({ code: 'return "repeat-guard-end";' })).toEqual({ isError: false, text: "repeat-guard-end" });
});

// Dogfooding: every program had a fixed 120 s, so a long build or test suite could not run at all
// with fabricOnly on. The call now sets its own limit (proofs/call-timeout.ts).
test("a call's timeout is its program's time limit, and a bad one is named", async () => {
  const slow = "await new Promise((resolve) => setTimeout(resolve, 2_000)); return 'slow';";
  const limited = await call({ code: slow, timeout: 300 });
  expect(limited.isError).toBe(true);
  expect(limited.text).toContain("timed out after 300ms");
  expect(await call({ code: "return 'quick';", timeout: null })).toEqual({ isError: false, text: "quick" });
  expect(await call({ code: "return 1;", timeout: 1.5 })).toEqual({
    isError: true,
    text: "fabric_exec: timeout must be a whole number of ms, like 300000; the most is 600000.",
  });
});
