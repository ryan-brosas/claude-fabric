// The real MCP server with the test playing the Fabric mod's half of the socket: it reads the
// secret the server wrote, sends the session's catalog, takes each job and answers it. No MCP
// server is involved, and no Claude Code: the answer is what the mod would get from one.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BRIDGE_HEADER, boundSecret, bridgePaths, type BridgeAnswer, type BridgeCatalog, type BridgeJob, type McpJob } from "../../src/bridge/contract.ts";

const root = new URL("../..", import.meta.url).pathname;
const SESSION = "fabric-mcp-test";

/** The MCP half of a job: these tests answer only MCP calls. */
const mcpJob = (job: BridgeJob): McpJob => {
  if (job.kind !== "mcp") throw new Error("this test answers only MCP jobs");
  return job;
};

const CATALOG: BridgeCatalog = {
  servers: [
    { server: "context7", tools: [{ name: "resolve-library-id", description: "Resolves a library name to its Context7 id." }] },
    { server: "claude.ai Gmail", tools: [{ name: "list_messages" }] },
  ],
};

let client: Client;
let work: string;
let data: string;
let paths: ReturnType<typeof bridgePaths>;
let stopMod: () => Promise<void>;
const received: BridgeJob[] = [];
let answer: (job: BridgeJob) => BridgeAnswer = (job) => ({
  id: job.id,
  ok: true,
  result: { content: [{ type: "text", text: "no handler" }], isError: false },
});

const waitFor = async (check: () => boolean, ms = 4000): Promise<void> => {
  const start = performance.now();
  while (!check() && performance.now() - start < ms) await Bun.sleep(10);
  if (!check()) throw new Error("the condition did not hold");
};

const call = async (code: string, target: Client = client) => {
  const r = await target.callTool({ name: "fabric_exec", arguments: { code } });
  return { isError: Boolean(r.isError), text: (r.content as { text: string }[])[0].text };
};

const secret = async (target = paths): Promise<string> => boundSecret(await Bun.file(target.secret).text(), SESSION) ?? "";

const post = async (
  path: string,
  body: unknown,
  options: { target?: ReturnType<typeof bridgePaths>; secret?: string; signal?: AbortSignal } = {},
): Promise<Response> => {
  const target = options.target ?? paths;
  return fetch("http://bridge" + path, {
    method: "POST",
    headers: { [BRIDGE_HEADER]: options.secret ?? await secret(target), "content-type": "application/json" },
    body: JSON.stringify(body),
    unix: target.socket,
    signal: options.signal,
  });
};

// The mod's side, polling as the real mod does: each poll runs until the server's own limit, never
// cut short by the client, since a poll cut short just as the server hands it a job loses that job.
// Stopping aborts the one poll in flight. Each job is answered with whatever the current handler says.
const startMod = (target = paths): (() => Promise<void>) => {
  let stop = false;
  const stopped = new AbortController();
  const loop = (async () => {
    while (!stop) {
      try {
        const response = await post("/next", {}, { target, signal: stopped.signal });
        if (!response.ok) continue;
        const body = await response.json() as { job: BridgeJob | null };
        if (body.job !== null) {
          received.push(body.job);
          await post("/answer", answer(body.job), { target });
        }
      } catch {
        // The test stopped the loop, or the server is not listening yet.
        if (!stop) await Bun.sleep(10);
      }
    }
  })();
  return async () => {
    stop = true;
    stopped.abort();
    await loop.catch(() => undefined);
  };
};

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "fabric-mcp-work-"));
  data = await mkdtemp(join(tmpdir(), "fabric-mcp-data-"));
  paths = bridgePaths(data, SESSION);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: "bun",
    args: [root + "src/server/index.ts"],
    env: { ...process.env, CLAUDE_PROJECT_DIR: work, CLAUDE_PLUGIN_DATA: data, CLAUDE_CODE_SESSION_ID: SESSION } as Record<string, string>,
  }));
  const start = performance.now();
  while (!(await Bun.file(paths.secret).exists()) && performance.now() - start < 4000) await Bun.sleep(10);
  expect(await Bun.file(paths.secret).exists()).toBe(true);
  expect((await post("/catalog", CATALOG)).status).toBe(200);
  stopMod = startMod();
});

afterAll(async () => {
  await stopMod();
  await client.close();
  await rm(work, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
});

test("refuses a request that does not carry this session's secret", async () => {
  expect((await post("/next", {}, { secret: "wrong" })).status).toBe(403);
});

test("a program calls a connected server's tool, and gets its text and structured content", async () => {
  answer = (job) => ({
    id: job.id,
    ok: true,
    result: {
      content: [{ type: "text", text: "Found: /facebook/react" }, { type: "text", text: "second block" }, { type: "image", mimeType: "image/png" }],
      isError: false,
      structuredContent: { id: "/facebook/react" },
    },
  });
  const result = await call('return await mcp.context7.resolve_library_id({ libraryName: "react" });');
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.text)).toEqual({ text: "Found: /facebook/react\nsecond block", structuredContent: { id: "/facebook/react" } });
  expect(received.at(-1)).toEqual({ kind: "mcp", id: 1, server: "context7", tool: "resolve-library-id", args: { libraryName: "react" } });
});

test("the sanitized key and the bracket key reach the same server and tool", async () => {
  answer = (job) => ({ id: job.id, ok: true, result: { content: [{ type: "text", text: mcpJob(job).server + "/" + mcpJob(job).tool }], isError: false } });
  const result = await call('return [await mcp.claude_ai_Gmail.list_messages(), await mcp["claude.ai Gmail"].list_messages()];');
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.text)).toEqual([{ text: "claude.ai Gmail/list_messages" }, { text: "claude.ai Gmail/list_messages" }]);
  expect(received.slice(-2).map((job) => mcpJob(job).server)).toEqual(["claude.ai Gmail", "claude.ai Gmail"]);
});

test("parallel mcp calls are parallel jobs, and each answer comes back to its own call", async () => {
  answer = (job) => ({ id: job.id, ok: true, result: { content: [{ type: "text", text: mcpJob(job).server + "/" + mcpJob(job).tool }], isError: false } });
  const result = await call('const [a, b] = await Promise.all([mcp.context7.resolve_library_id({ libraryName: "a" }), mcp.claude_ai_Gmail.list_messages()]); return [a.text, b.text];');
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.text)).toEqual(["context7/resolve-library-id", "claude.ai Gmail/list_messages"]);
});

test("a result the server marks as an error rejects inside the program", async () => {
  answer = (job) => ({ id: job.id, ok: false, error: "the server needs sign-in" });
  const result = await call('return await mcp.context7.resolve_library_id({ libraryName: "react" }).catch((e: Error) => e.message);');
  expect(result).toEqual({ isError: false, text: "the server needs sign-in" });
});

test("a tool outside the catalog fails clearly and never leaves the server", async () => {
  const before = received.length;
  const result = await call('return await mcp.context7.not_a_tool().catch((e: Error) => e.message);');
  expect(result.isError).toBe(false);
  expect(result.text).toBe('mcp.context7.not_a_tool: MCP server "context7" has no tool named "not_a_tool". Tools: resolve-library-id.');
  await Bun.sleep(300);
  expect(received.length).toBe(before);
});

test("this plugin's own server cannot be called from a program", async () => {
  const result = await call('return await mcp.fabric.fabric_exec({ code: "return 1" }).catch((e: Error) => e.message);');
  expect(result.text).toContain("the fabric server is this session's own fabric_exec");
});

test("a program with no mod connected fails at once and says so", async () => {
  const lonely = await mkdtemp(join(tmpdir(), "fabric-mcp-nomod-"));
  const lonelyWork = await mkdtemp(join(tmpdir(), "fabric-mcp-nomod-work-"));
  const target = new Client({ name: "test", version: "0.0.0" });
  await target.connect(new StdioClientTransport({
    command: "bun",
    args: [root + "src/server/index.ts"],
    env: { ...process.env, CLAUDE_PROJECT_DIR: lonelyWork, CLAUDE_PLUGIN_DATA: lonely, CLAUDE_CODE_SESSION_ID: "no-mod" } as Record<string, string>,
  }));
  try {
    const start = performance.now();
    const result = await call('return await mcp.context7.resolve_library_id({ libraryName: "react" }).catch((e: Error) => e.message);', target);
    expect(result.text).toContain("the Fabric mod has sent no catalog");
    expect(performance.now() - start).toBeLessThan(3000);
  } finally {
    await target.close();
    await rm(lonely, { recursive: true, force: true });
    await rm(lonelyWork, { recursive: true, force: true });
  }
});
