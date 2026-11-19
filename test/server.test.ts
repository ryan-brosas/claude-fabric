import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOL_NAMES } from "../kernel/protocol.ts";

const root = new URL("..", import.meta.url).pathname;
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
    args: [root + "server/index.ts"],
    env: { ...process.env, CLAUDE_PROJECT_DIR: work } as Record<string, string>,
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

test("unknown display keys are accepted", async () => {
  expect(await call({ code: "return 1 + 1;", display: { name: "sum", extra: true } })).toEqual({ isError: false, text: "2" });
});

test("a program without return runs, and its print output comes back", async () => {
  const r = await call({ code: 'print("ran");' });
  expect(r.isError).toBe(false);
  expect(r.text.startsWith("ran")).toBe(true);
});
