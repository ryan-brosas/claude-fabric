import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = new URL("..", import.meta.url).pathname;
let client: Client;

beforeAll(async () => {
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: "bun",
    args: [root + "server/index.ts"],
    env: { ...process.env, CLAUDE_PROJECT_DIR: root } as Record<string, string>,
  }));
});
afterAll(async () => { await client.close(); });

const call = async (args: Record<string, unknown>) => {
  const r = await client.callTool({ name: "fabric_exec", arguments: args });
  return { isError: Boolean(r.isError), text: (r.content as { text: string }[])[0].text };
};

test("lists exactly one tool, fabric_exec", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toEqual(["fabric_exec"]);
  expect(tools[0].inputSchema.required).toEqual(["code"]);
});

test("reads a file relative to CLAUDE_PROJECT_DIR", async () => {
  const r = await call({ code: 'return JSON.parse(await pi.read("package.json")).name;' });
  expect(r).toEqual({ isError: false, text: "claude-fabric" });
});

test("runs parallel calls and keeps print output", async () => {
  const r = await call({ code: 'const [a, b] = await Promise.all([pi.bash("echo one"), pi.bash("echo two")]); print("both done"); return a.output.trim() + b.output.trim();' });
  expect(r).toEqual({ isError: false, text: "both done\nonetwo" });
});

test("type error is reported and nothing runs", async () => {
  const r = await call({ code: 'await pi.bash("touch should-not-exist"); const n: number = "x"; return n;' });
  expect(r.isError).toBe(true);
  expect(r.text).toContain("line 1:");
  expect(await Bun.file(root + "should-not-exist").exists()).toBe(false);
});

test("payloads arrive as π and a missing key names the provided keys", async () => {
  expect(await call({ code: "return π.note.length;", payloads: { note: "a`b${c}" } })).toEqual({ isError: false, text: "7" });
  const missing = await call({ code: "return π.other;", payloads: { note: "x" } });
  expect(missing.isError).toBe(true);
  expect(missing.text).toContain("Provided keys: note");
});

test("unknown display keys are accepted", async () => {
  const r = await call({ code: "return 1 + 1;", display: { name: "sum", extra: true } });
  expect(r).toEqual({ isError: false, text: "2" });
});
