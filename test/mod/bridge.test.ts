// The mod's half of the socket: the catalog a tool list makes, the plain data the hook bodies
// hand around, and the loop that publishes it and answers a job with Claude Code's own MCP call.
// The engine is played here by plain objects, so no MCP server and no Claude Code are involved.
import { describe, expect, test } from "bun:test";
import { BRIDGE_HEADER, bridgePaths } from "../../src/bridge/contract.ts";
import {
  answerOf,
  catalogOf,
  emptyState,
  failureOf,
  jobOf,
  markedPosted,
  notedSecret,
  notedTools,
  publishPlan,
  requestOf,
  retryDelay,
} from "../../src/mod/bridge.ts";
import { register } from "../../src/mod/index.ts";

const tools = [
  { name: "mcp__context7__resolve-library-id", description: "Resolves a library name.", mcp: true },
  { name: "mcp__plugin_fabric_fabric__fabric_exec", description: "Runs programs.", mcp: true },
  { name: "mcp__claude_ai_Gmail__list_messages", description: "", mcp: true },
  { name: "Read", description: "Reads a file.", mcp: false },
  { name: "not_an_mcp_name", description: "Nothing to split.", mcp: true },
];

interface Request { path: string; body: unknown; secret?: string; socketPath?: string }
interface Asked { server: string; tool: string; args?: Record<string, unknown> }
interface Fake {
  $: Record<string, unknown>;
  requests: Request[];
  asked: Asked[];
  /** Every built-in tool call the mod made, as the input it passed `$.tool.call`. */
  ran: Record<string, unknown>[];
  waits: number[];
  deliver: (job: unknown) => void;
  refuse: (times: number) => void;
}

function fake(pluginData = "/data/plugins"): Fake {
  const requests: Request[] = [];
  const asked: Asked[] = [];
  const ran: Record<string, unknown>[] = [];
  const waits: number[] = [];
  const jobs: unknown[] = [];
  const parked: ((job: unknown) => void)[] = [];
  let refusals = 0;
  const reply = (job: unknown | null) => ({ ok: true, status: 200, text: JSON.stringify({ job }) });
  const $ = {
    session: { id: async () => "session-1" },
    process: { hookEnv: async () => (pluginData === "" ? {} : { CLAUDE_PLUGIN_DATA: pluginData }) },
    fs: {
      read: async (path: string) => {
        if (!path.endsWith(".key")) throw new Error("ENOENT");
        return "the-secret\n";
      },
    },
    clock: {
      after: (ms: number, run: () => void) => {
        waits.push(ms);
        const id = setTimeout(run, 0);
        return { cancel: () => clearTimeout(id) };
      },
    },
    ui: { log: () => undefined },
    mcp: {
      call: async (server: string, tool: string, args: Record<string, unknown>) => {
        asked.push({ server, tool, args });
        return { content: [{ type: "text", text: "answered" }], isError: false };
      },
    },
    tool: {
      call: async (input: Record<string, unknown>) => {
        ran.push(input);
        return { result: { query: input.query, results: [] }, text: "A web answer." };
      },
    },
    http: {
      fetch: async (url: string, init: { headers: Record<string, string>; body: string; socketPath?: string }) => {
        if (refusals > 0) {
          refusals--;
          throw new Error("connect ECONNREFUSED");
        }
        const path = new URL(url).pathname;
        requests.push({ path, body: JSON.parse(init.body), secret: init.headers[BRIDGE_HEADER], socketPath: init.socketPath });
        if (path !== "/next") return { ok: true, status: 200, text: '{"ok":true}' };
        const job = jobs.shift();
        if (job !== undefined) return reply(job);
        return new Promise((resolve) => { parked.push((value) => resolve(reply(value))); });
      },
    },
  };
  return {
    $,
    requests,
    asked,
    ran,
    waits,
    deliver: (job) => {
      const waiter = parked.shift();
      if (waiter) waiter(job);
      else jobs.push(job);
    },
    refuse: (times) => { refusals = times; },
  };
}

const waitFor = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  if (!check()) throw new Error("the condition did not hold");
};

type Handler = (dollar: unknown, event: unknown, next: (event: unknown) => unknown) => unknown;

// The hooks the mod registered, by topic, driven the way the engine drives them.
function hooks(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const on = (topic: string, handler: Handler) => {
    handlers.set(topic, handler);
    return { catch: () => undefined };
  };
  register(on as never, {} as never);
  return handlers;
}

const hook = (handlers: Map<string, Handler>, topic: string): Handler => {
  const found = handlers.get(topic);
  if (found === undefined) throw new Error("the mod registered no " + topic + " hook");
  return found;
};

describe("the catalog a session's tools make", () => {
  test("holds the MCP tools by server, leaves out this plugin's own, and keeps names whole", () => {
    expect(catalogOf(tools)).toEqual({
      servers: [
        { server: "context7", tools: [{ name: "resolve-library-id", description: "Resolves a library name." }] },
        { server: "claude_ai_Gmail", tools: [{ name: "list_messages" }] },
      ],
    });
  });

  test("is empty when the session lists no MCP tool", () => {
    expect(catalogOf([{ name: "Read", description: "Reads.", mcp: false }])).toEqual({ servers: [] });
    expect(catalogOf([])).toEqual({ servers: [] });
  });

  test("leaves out a wire name whose server boundary cannot be known", () => {
    expect(catalogOf([{ name: "mcp__a__b__t", description: "", mcp: true }])).toEqual({ servers: [] });
  });
});

describe("the plain data the hook bodies hand around", () => {
  test("a tool list is one more version to publish, and a taken version is published once", () => {
    const noted = notedTools(emptyState(), tools);
    expect(noted.version).toBe(1);
    expect(publishPlan(noted)).toEqual({ path: "/catalog", body: catalogOf(tools), version: 1 });
    expect(publishPlan(markedPosted(noted, 1))).toBeUndefined();
    expect(publishPlan(emptyState())).toBeUndefined();
    expect(markedPosted(noted, 1)).not.toBe(noted);
    const taken = markedPosted(noted, 1);
    expect(markedPosted(taken, 1)).toBe(taken);
  });

  test("a changed server secret republishes the catalog already posted", () => {
    const posted = markedPosted(notedTools(emptyState(), tools), 1);
    expect(publishPlan(posted)).toBeUndefined();
    const restarted = notedSecret(posted, "a-new-secret");
    expect(restarted.posted).toBe(-1);
    expect(publishPlan(restarted)).toEqual({ path: "/catalog", body: catalogOf(tools), version: 1 });
    expect(notedSecret(restarted, "a-new-secret")).toBe(restarted);
    expect(markedPosted(restarted, 1).posted).toBe(1);
  });

  test("a request carries the secret header, the body and this session's socket", () => {
    const paths = bridgePaths("/data/plugins", "session-1");
    expect(requestOf("/next", "s3cret", {}, paths)).toEqual({
      url: "http://bridge/next",
      init: {
        method: "POST",
        headers: { [BRIDGE_HEADER]: "s3cret", "content-type": "application/json" },
        body: "{}",
        socketPath: paths.socket,
      },
    });
  });

  test("a poll's job is read whole, in both kinds, and a body that is not one is no job", () => {
    expect(jobOf('{"job":{"kind":"mcp","id":7,"server":"context7","tool":"x","args":{"a":1}}}'))
      .toEqual({ kind: "mcp", id: 7, server: "context7", tool: "x", args: { a: 1 } });
    expect(jobOf('{"job":{"kind":"mcp","id":8,"server":"context7","tool":"x"}}'))
      .toEqual({ kind: "mcp", id: 8, server: "context7", tool: "x", args: {} });
    expect(jobOf('{"job":{"kind":"builtin","id":9,"tool":"WebSearch","input":{"query":"pi"}}}'))
      .toEqual({ kind: "builtin", id: 9, tool: "WebSearch", input: { query: "pi" } });
    expect(jobOf('{"job":{"kind":"builtin","id":10,"tool":"WebSearch"}}'))
      .toEqual({ kind: "builtin", id: 10, tool: "WebSearch", input: {} });
    for (const text of [
      '{"job":null}', "{}", "not json",
      '{"job":{"id":"7","server":"s","tool":"t"}}',
      '{"job":{"kind":"mcp","id":7,"tool":"t"}}',
      '{"job":{"kind":"builtin","id":7}}',
      // A job of no known kind is not run on a guess.
      '{"job":{"id":7,"server":"s","tool":"t","args":{}}}',
      '{"job":{"kind":"other","id":7,"tool":"t"}}',
    ]) {
      expect({ text, job: jobOf(text) }).toEqual({ text, job: undefined });
    }
  });

  test("an answer is the call's result or its failure, and a wait grows to four seconds", () => {
    expect(answerOf(1, { content: [] })).toEqual({ id: 1, ok: true, result: { content: [] } });
    expect(failureOf(2, new Error("needs sign-in"))).toEqual({ id: 2, ok: false, error: "needs sign-in" });
    expect(failureOf(3, "not an error")).toEqual({ id: 3, ok: false, error: "not an error" });
    expect([0, 1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([250, 500, 1000, 2000, 4000, 4000, 4000]);
  });
});

describe("the mod's socket loop", () => {
  test("session.start starts it, the tool list publishes, and a job is answered with the MCP call's result", async () => {
    const handlers = hooks();
    const harness = fake();
    const event = { cwd: "/work", surface: null, isInteractive: false };
    expect(await hook(handlers, "session.start")(harness.$, event, (e) => ({ cwd: (e as { cwd: string }).cwd })))
      .toEqual({ cwd: "/work" });
    await waitFor(() => harness.requests.some((request) => request.path === "/next"));

    // The tool list's answer goes back untouched, and the catalog follows over the socket.
    const listed = { value: tools };
    expect(await hook(handlers, "tool.list")(harness.$, { tool: "tool.list" }, () => listed)).toEqual(listed);
    await waitFor(() => harness.requests.some((request) => request.path === "/catalog"));
    const catalog = harness.requests.find((request) => request.path === "/catalog");
    expect(catalog?.body).toEqual(catalogOf(tools));
    expect(catalog?.secret).toBe("the-secret");

    const paths = bridgePaths("/data/plugins", "session-1");
    expect(catalog?.socketPath).toBe(paths.socket);
    expect(harness.requests.find((request) => request.path === "/next")?.socketPath).toBe(paths.socket);

    harness.deliver({ kind: "mcp", id: 7, server: "context7", tool: "resolve-library-id", args: { libraryName: "react" } });
    await waitFor(() => harness.requests.some((request) => request.path === "/answer"));
    expect(harness.asked).toEqual([{ server: "context7", tool: "resolve-library-id", args: { libraryName: "react" } }]);
    expect(harness.requests.find((request) => request.path === "/answer")?.body).toEqual({
      id: 7,
      ok: true,
      result: { content: [{ type: "text", text: "answered" }], isError: false },
    });
  });

  test("a failed MCP call is answered as the job's error", async () => {
    const handlers = hooks();
    const harness = fake("/data/plugins");
    harness.$.mcp = { call: async () => { throw new Error("the server needs sign-in"); } };
    await hook(handlers, "session.start")(harness.$, { cwd: "/work", surface: null, isInteractive: false }, () => ({ cwd: "/work" }));
    harness.deliver({ kind: "mcp", id: 9, server: "context7", tool: "resolve-library-id", args: {} });
    await waitFor(() => harness.requests.some((request) => request.path === "/answer"));
    expect(harness.requests.find((request) => request.path === "/answer")?.body).toEqual({ id: 9, ok: false, error: "the server needs sign-in" });
  });

  test("a built-in tool job is run with `$.tool.call`, and its answer carries what that returned", async () => {
    const handlers = hooks();
    const harness = fake();
    await hook(handlers, "session.start")(harness.$, { cwd: "/work", surface: null, isInteractive: false }, () => ({ cwd: "/work" }));
    await waitFor(() => harness.requests.some((request) => request.path === "/next"));
    harness.deliver({ kind: "builtin", id: 11, tool: "WebSearch", input: { query: "pi fabric", mode: "standard" } });
    await waitFor(() => harness.requests.some((request) => request.path === "/answer"));
    // One literal call, with the job's own name and its input spread beside it.
    expect(harness.ran).toEqual([{ tool: "WebSearch", query: "pi fabric", mode: "standard" }]);
    expect(harness.asked).toEqual([]);
    expect(harness.requests.find((request) => request.path === "/answer")?.body).toEqual({
      id: 11,
      ok: true,
      result: { result: { query: "pi fabric", results: [] }, text: "A web answer." },
    });
  });

  test("the mod's own wall refuses a built-in tool the host's allowlist does not hold", async () => {
    const handlers = hooks();
    const harness = fake();
    await hook(handlers, "session.start")(harness.$, { cwd: "/work", surface: null, isInteractive: false }, () => ({ cwd: "/work" }));
    await waitFor(() => harness.requests.some((request) => request.path === "/next"));
    harness.deliver({ kind: "builtin", id: 12, tool: "Agent", input: { description: "d", prompt: "p" } });
    await waitFor(() => harness.requests.some((request) => request.path === "/answer"));
    expect(harness.ran).toEqual([]);
    expect(harness.requests.find((request) => request.path === "/answer")?.body).toEqual({
      id: 12,
      ok: false,
      error: 'the Fabric mod runs no built-in tool named "Agent"; a program may call only WebSearch',
    });
  });

  test("a tool key inside a WebSearch job's input cannot name another tool", async () => {
    const handlers = hooks();
    const harness = fake();
    await hook(handlers, "session.start")(harness.$, { cwd: "/work", surface: null, isInteractive: false }, () => ({ cwd: "/work" }));
    await waitFor(() => harness.requests.some((request) => request.path === "/next"));
    harness.deliver({ kind: "builtin", id: 13, tool: "WebSearch", input: { query: "q", tool: "Bash", command: "id" } });
    await waitFor(() => harness.requests.some((request) => request.path === "/answer"));
    expect(harness.ran.map((call) => (call as { tool: string }).tool)).toEqual(["WebSearch"]);
  });

  test("a socket that is not up yet is asked again, and the wait grows", async () => {
    const handlers = hooks();
    const harness = fake();
    harness.refuse(2);
    await hook(handlers, "session.start")(harness.$, { cwd: "/work", surface: null, isInteractive: false }, () => ({ cwd: "/work" }));
    await waitFor(() => harness.requests.some((request) => request.path === "/next"));
    expect(harness.waits).toEqual([retryDelay(1), retryDelay(2)]);
  });

  test("a tool list that lands before the loop knows the socket is published by the loop", async () => {
    const handlers = hooks();
    const harness = fake();
    const listed = { value: tools };
    expect(await hook(handlers, "tool.list")(harness.$, { tool: "tool.list" }, () => listed)).toEqual(listed);
    expect(harness.requests).toEqual([]);

    await hook(handlers, "session.start")(harness.$, { cwd: "/work", surface: null, isInteractive: false }, () => ({ cwd: "/work" }));
    await waitFor(() => harness.requests.some((request) => request.path === "/catalog"));
    expect(harness.requests.find((request) => request.path === "/catalog")?.body).toEqual(catalogOf(tools));
  });

  test("reposts the catalog when the server comes back with a new secret", async () => {
    const handlers = hooks();
    const harness = fake();
    await hook(handlers, "session.start")(harness.$, { cwd: "/work", surface: null, isInteractive: false }, () => ({ cwd: "/work" }));
    await hook(handlers, "tool.list")(harness.$, { tool: "tool.list" }, () => ({ value: tools }));
    await waitFor(() => harness.requests.some((request) => request.path === "/catalog"));
    await Bun.sleep(50); // let the loop and the hook settle their one publish
    const before = harness.requests.filter((request) => request.path === "/catalog").length;
    harness.$.fs = { read: async () => "a-new-secret\n" };
    harness.deliver({ kind: "mcp", id: 3, server: "context7", tool: "resolve-library-id", args: {} });
    await waitFor(() => harness.requests.filter((request) => request.path === "/catalog").length > before);
    const last = harness.requests.filter((request) => request.path === "/catalog").at(-1);
    expect(last?.secret).toBe("a-new-secret");
    expect(last?.body).toEqual(catalogOf(tools));
  });

  test("a plugin data folder that is not there starts no loop and says why", async () => {
    const handlers = hooks();
    const harness = fake("");
    const logs: string[] = [];
    harness.$.ui = { log: (line: string) => logs.push(line) };
    await hook(handlers, "session.start")(harness.$, { cwd: "/work", surface: null, isInteractive: false }, () => ({ cwd: "/work" }));
    await waitFor(() => logs.length > 0);
    expect(logs).toEqual(["fabric: CLAUDE_PLUGIN_DATA is empty, so mcp.<server>.<tool>() and WebSearch cannot reach this session's tools"]);
    expect(harness.requests).toEqual([]);
  });
});
