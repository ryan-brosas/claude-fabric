// The real MCP server with the test playing the Fabric mod's half of the socket: the mod long-polls
// `/next`, takes a built-in tool job and answers it with what `$.tool.call` would return. No web
// search happens here, and no Claude Code is involved.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BRIDGE_HEADER, boundSecret, bridgePaths, type BridgeAnswer, type BridgeJob, type BuiltinJob } from "../../src/bridge/contract.ts";

const root = new URL("../..", import.meta.url).pathname;
const SESSION = "fabric-websearch-test";

let client: Client;
let work: string;
let data: string;
let paths: ReturnType<typeof bridgePaths>;
let stopMod: () => Promise<void>;
const received: BridgeJob[] = [];
let answer: (job: BuiltinJob) => BridgeAnswer = (job) => ({
  id: job.id,
  ok: true,
  result: { result: { query: String(job.input.query ?? ""), results: [] }, text: "A web answer." },
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

const builtinJob = (job: BridgeJob): BuiltinJob => {
  if (job.kind !== "builtin") throw new Error("this test answers only built-in jobs");
  return job;
};

const post = async (
  path: string,
  body: unknown,
  options: { target?: ReturnType<typeof bridgePaths>; secret?: string; signal?: AbortSignal } = {},
): Promise<Response> => {
  const target = options.target ?? paths;
  const secret = options.secret ?? boundSecret(await Bun.file(target.secret).text(), SESSION) ?? "";
  return fetch("http://bridge" + path, {
    method: "POST",
    headers: { [BRIDGE_HEADER]: secret, "content-type": "application/json" },
    body: JSON.stringify(body),
    unix: target.socket,
    signal: options.signal,
  });
};

// The mod's side: a long poll cut short every 250 ms, so a test can stop it, and each job answered
// with whatever the current handler says.
const startMod = (target = paths): (() => Promise<void>) => {
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        const response = await post("/next", {}, { target, signal: AbortSignal.timeout(250) });
        if (!response.ok) continue;
        const body = await response.json() as { job: BridgeJob | null };
        if (body.job !== null) {
          received.push(body.job);
          await post("/answer", answer(builtinJob(body.job)), { target });
        }
      } catch {
        // The poll timed out, or the server is not listening yet.
      }
    }
  })();
  return async () => {
    stop = true;
    await loop.catch(() => undefined);
  };
};

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "fabric-websearch-work-"));
  // A program's own file, so the server-side tools still have work to do in this session.
  await Bun.write(join(work, "a.txt"), "alpha\n");
  data = await mkdtemp(join(tmpdir(), "fabric-websearch-data-"));
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
  stopMod = startMod();
});

afterAll(async () => {
  await stopMod();
  await client.close();
  await rm(work, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
});

test("a program calls WebSearch and gets the answer text and the hits", async () => {
  answer = (job) => ({
    id: job.id,
    ok: true,
    result: {
      result: {
        query: job.input.query,
        results: [
          { tool_use_id: "toolu_1", content: [
            { title: "pi-fabric", url: "https://github.com/fabric-runtime/pi-fabric", snippet: "A runtime for Pi." },
            { title: "Fabric docs", url: "https://example.com/docs" },
          ] },
          "a string entry, which names no hit",
        ],
        durationSeconds: 1.4,
        searchCount: 2,
      },
      text: "Found pi-fabric and its docs.",
    },
  });
  const before = received.length;
  const result = await call('return await WebSearch({ query: "pi fabric", allowed_domains: ["github.com"] });');
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.text)).toEqual({
    text: "Found pi-fabric and its docs.",
    results: [
      { title: "pi-fabric", url: "https://github.com/fabric-runtime/pi-fabric", snippet: "A runtime for Pi." },
      { title: "Fabric docs", url: "https://example.com/docs" },
    ],
  });
  // The job carries Claude Code's own tool name and fields, with mode filled in as standard.
  expect(received.length).toBe(before + 1);
  expect(received.at(-1)).toEqual({
    kind: "builtin",
    id: expect.any(Number),
    tool: "WebSearch",
    input: { query: "pi fabric", mode: "standard", allowed_domains: ["github.com"] },
  });
});

test("the one-string shorthand works, and extended mode is passed as asked", async () => {
  answer = (job) => ({ id: job.id, ok: true, result: { result: { results: [] }, text: "mode " + String(job.input.mode) } });
  const shorthand = await call('return (await WebSearch("pi fabric")).text;');
  expect(shorthand).toEqual({ isError: false, text: "mode standard" });
  const extended = await call('return (await WebSearch({ query: "pi fabric", mode: "extended" })).text;');
  expect(extended).toEqual({ isError: false, text: "mode extended" });
  expect(received.slice(-2).map((job) => builtinJob(job).input.mode)).toEqual(["standard", "extended"]);
});

test("a job the mod marks as a failure rejects inside the program", async () => {
  answer = (job) => ({ id: job.id, ok: false, error: "the search needs a sign-in" });
  const result = await call('return await WebSearch("pi").catch((e: Error) => e.message);');
  expect(result).toEqual({ isError: false, text: "the search needs a sign-in" });
});

test("no other built-in tool ever reaches the socket, and the server-side tools still run here", async () => {
  const before = received.length;
  // Read runs in the server: no job, and no built-in tool call.
  expect(await call('return (await Read("a.txt")).length > 0;')).toEqual({ isError: false, text: "true" });
  // A program cannot name a built-in tool the registry does not declare: only WebSearch is a
  // program tool, so Agent fails the check before anything runs.
  const refused = await call('return await Agent({ prompt: "x" });');
  expect(refused.isError).toBe(true);
  expect(refused.text.startsWith("Type errors; code was not executed:")).toBe(true);
  expect(refused.text).toContain("Agent");
  await Bun.sleep(300);
  expect(received.length).toBe(before);
  // Every job the socket has seen is the one tool the allowlist holds.
  expect(received.every((job) => job.kind === "builtin" && job.tool === "WebSearch")).toBe(true);
});

test("with no mod connected, a WebSearch call fails at once and says why", async () => {
  const lonelyWork = await mkdtemp(join(tmpdir(), "fabric-websearch-nomod-work-"));
  const target = new Client({ name: "test", version: "0.0.0" });
  await target.connect(new StdioClientTransport({
    command: "bun",
    args: [root + "src/server/index.ts"],
    // No plugin data, so the bridge never starts and the tool says so instead of waiting.
    env: { ...process.env, CLAUDE_PROJECT_DIR: lonelyWork, CLAUDE_PLUGIN_DATA: "", CLAUDE_CODE_SESSION_ID: "" } as Record<string, string>,
  }));
  try {
    const start = performance.now();
    const result = await call('return await WebSearch("pi").catch((e: Error) => e.message);', target);
    expect(result.text).toContain("CLAUDE_PLUGIN_DATA is not set");
    expect(performance.now() - start).toBeLessThan(3000);
  } finally {
    await target.close();
    await rm(lonelyWork, { recursive: true, force: true });
  }
});
