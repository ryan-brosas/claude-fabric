// The socket between the server and the mod, over a real Unix socket in a temporary folder. The
// mod's half is played here with plain fetches: connect, send a catalog, take a job, answer it.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGE_HEADER,
  SOCKET_PATH_LIMIT,
  bridgePathProblem,
  bridgePaths,
  isBridgeCatalog,
  isBuiltinTool,
  isFabricServer,
  splitMcpToolName,
  type BridgeJob,
} from "../../src/bridge/contract.ts";
import { startBridge, type Bridge, type BridgeStart } from "../../src/kernel/bridge/server.ts";

const SECRET = "test-secret";

const folders: string[] = [];
const bridges: Bridge[] = [];

async function folder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fabric-bridge-"));
  folders.push(dir);
  return dir;
}

async function serve(options: { sessionId?: string; answerTimeoutMs?: number; pollMs?: number } = {}): Promise<{ bridge: Bridge; paths: ReturnType<typeof bridgePaths>; dir: string }> {
  const dir = await folder();
  const { sessionId = "s1", ...rest } = options;
  const started: BridgeStart = await startBridge({ pluginData: dir, sessionId, ...rest });
  if (!("bridge" in started)) throw new Error(started.error);
  bridges.push(started.bridge);
  return { bridge: started.bridge, paths: started.bridge.paths, dir };
}

const post = (socket: string, path: string, body: unknown, secret = SECRET, signal?: AbortSignal): Promise<Response> =>
  fetch("http://bridge" + path, {
    method: "POST",
    headers: { [BRIDGE_HEADER]: secret, "content-type": "application/json" },
    body: JSON.stringify(body),
    unix: socket,
    signal,
  });

const answer = (socket: string, secret: string, body: unknown) => post(socket, "/answer", body, secret);

afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.close();
  for (const dir of folders.splice(0)) await rm(dir, { recursive: true, force: true });
});

// A test's secret is the one the server wrote; the constant above only proves a wrong one is refused.
const secretOf = async (paths: ReturnType<typeof bridgePaths>): Promise<string> => (await Bun.file(paths.secret).text()).trim();

describe("the bridge's paths", () => {
  test("builds the socket and its secret under the plugin's data folder", () => {
    expect(bridgePaths("/data/", "abc")).toEqual({
      dir: "/data/bridge",
      socket: "/data/bridge/abc.sock",
      secret: "/data/bridge/abc.key",
      lock: "/data/bridge/abc.lock",
    });
  });

  test("refuses a socket path over the Unix limit, on both sides of the rule", () => {
    expect(bridgePathProblem(bridgePaths("/short", "abc"))).toBeUndefined();
    const long = bridgePaths("/" + "x".repeat(SOCKET_PATH_LIMIT), "abc");
    expect(long.socket.length).toBeGreaterThan(SOCKET_PATH_LIMIT);
    expect(bridgePathProblem(long)).toContain("over the Unix socket limit");
  });

  test("fits an installed plugin's data folder with a real session id", () => {
    // The folder Claude Code gives the plugin when it is installed from the fabric-exec marketplace.
    const installed = "/home/someone/.claude/plugins/data/fabric-fabric-exec";
    const paths = bridgePaths(installed, "83cc3a05-e248-4b4d-8fac-a741e780889e");
    expect(paths.socket).toBe(installed + "/bridge/83cc3a05e2484b4d8fac.sock");
    expect(bridgePathProblem(paths)).toBeUndefined();
  });

  test("refuses a session id with nothing to name a file by", () => {
    expect(bridgePathProblem(bridgePaths("/data", "---"))).toContain("session id");
  });
});

describe("the tool-name spelling", () => {
  test("splits the server at the first separator and keeps the rest as the tool", () => {
    expect(splitMcpToolName("mcp__context7__resolve-library-id")).toEqual({ server: "context7", tool: "resolve-library-id" });
    expect(splitMcpToolName("mcp__claude_ai_Gmail__list_messages")).toEqual({ server: "claude_ai_Gmail", tool: "list_messages" });
  });

  test("names no server for a name that is not an MCP tool's", () => {
    expect(splitMcpToolName("Read")).toBeUndefined();
    expect(splitMcpToolName("mcp__only")).toBeUndefined();
    expect(splitMcpToolName("mcp____tool")).toBeUndefined();
    expect(splitMcpToolName("mcp__server__")).toBeUndefined();
    // A second __ leaves the server boundary unknowable: never guess it.
    expect(splitMcpToolName("mcp__a__b__t")).toBeUndefined();
    expect(splitMcpToolName("mcp__a__b__c__d")).toBeUndefined();
    // A separator that overlaps the first one is not a second candidate: mcp__a___t reads as
    // server a, tool _t and as server a_, tool t, so neither boundary is known.
    expect(splitMcpToolName("mcp__a___t")).toBeUndefined();
    expect(splitMcpToolName("mcp__a____t")).toBeUndefined();
    // A leading underscore inside one field is fine while the separators stay apart.
    expect(splitMcpToolName("mcp___a__t")).toEqual({ server: "_a", tool: "t" });
  });

  test("knows this plugin's own server in both spellings", () => {
    expect(isFabricServer("fabric")).toBe(true);
    expect(isFabricServer("plugin_fabric_fabric")).toBe(true);
    expect(isFabricServer("context7")).toBe(false);
  });

  test("allows exactly one built-in tool through the bridge", () => {
    expect(isBuiltinTool("WebSearch")).toBe(true);
    for (const name of ["Agent", "Read", "Bash", "WebFetch", "Skill"]) expect({ name, allowed: isBuiltinTool(name) }).toEqual({ name, allowed: false });
  });
});

describe("the catalog the mod sends", () => {
  test("holds a well-formed catalog and refuses anything else", () => {
    expect(isBridgeCatalog({ servers: [] })).toBe(true);
    expect(isBridgeCatalog({ servers: [{ server: "context7", tools: [{ name: "a", description: "b" }] }] })).toBe(true);
    expect(isBridgeCatalog({ servers: [{ server: "context7", tools: [{ name: "a", description: 3 }] }] })).toBe(false);
    expect(isBridgeCatalog({ servers: [{ server: 3, tools: [] }] })).toBe(false);
    expect(isBridgeCatalog({ servers: "context7" })).toBe(false);
    expect(isBridgeCatalog(undefined)).toBe(false);
  });
});

describe("the bridge over its socket", () => {
  test("keeps the folder 0700 and the secret 0600", async () => {
    const { paths } = await serve();
    expect((await stat(paths.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.secret)).mode & 0o777).toBe(0o600);
    expect((await secretOf(paths)).length).toBe(64);
  });

  test("refuses a request without this session's secret", async () => {
    const { bridge, paths } = await serve({ pollMs: 20 });
    const refused = await post(paths.socket, "/next", {}, "wrong");
    expect(refused.status).toBe(403);
    expect(await (await post(paths.socket, "/catalog", { servers: [] }, "wrong")).text()).toBe("forbidden");
    expect(bridge.catalog()).toEqual({ servers: [] });
    // The refusal did not count as the mod: a call still fails at once.
    await expect(bridge.call("context7", "x", {})).rejects.toThrow("no Fabric mod is connected");
  });

  test("holds the catalog the mod sends, and replaces it", async () => {
    const { bridge } = await serve({ pollMs: 20 });
    const catalog = { servers: [{ server: "context7", tools: [{ name: "resolve-library-id", description: "Resolves one." }] }] };
    expect(await (await post(bridge.paths.socket, "/catalog", catalog, await secretOf(bridge.paths))).json()).toEqual({ ok: true });
    expect(bridge.catalog()).toEqual(catalog);
    expect(await (await post(bridge.paths.socket, "/catalog", { servers: [] }, await secretOf(bridge.paths))).json()).toEqual({ ok: true });
    expect(bridge.catalog()).toEqual({ servers: [] });
  });

  test("refuses a malformed catalog and keeps the one it held", async () => {
    const { bridge } = await serve({ pollMs: 20 });
    const secret = await secretOf(bridge.paths);
    const catalog = { servers: [{ server: "context7", tools: [] }] };
    await post(bridge.paths.socket, "/catalog", catalog, secret);
    const bad = await post(bridge.paths.socket, "/catalog", { servers: [{ server: 3 }] }, secret);
    expect(bad.status).toBe(400);
    expect(bridge.catalog()).toEqual(catalog);
  });

  test("carries one call to the mod and its raw answer back", async () => {
    const { bridge, paths } = await serve({ pollMs: 200 });
    const secret = await secretOf(paths);
    await post(paths.socket, "/next", {}, secret); // the mod is here, and takes nothing yet
    const pending = bridge.call("context7", "resolve-library-id", { libraryName: "react" });
    void pending.catch(() => undefined);
    const reply = await (await post(paths.socket, "/next", {}, secret)).json() as { job: BridgeJob };
    expect(reply.job).toEqual({ kind: "mcp", id: 1, server: "context7", tool: "resolve-library-id", args: { libraryName: "react" } });
    const result = { content: [{ type: "text", text: "Found." }], isError: false };
    expect(await (await answer(paths.socket, secret, { id: 1, ok: true, result })).json()).toEqual({ ok: true });
    expect(await pending).toEqual(result);
  });

  test("carries a built-in tool job on the same queue, and its answer back", async () => {
    const { bridge, paths } = await serve({ pollMs: 200 });
    const secret = await secretOf(paths);
    await post(paths.socket, "/next", {}, secret); // the mod is here, and takes nothing yet
    const pending = bridge.tool("WebSearch", { query: "pi fabric", mode: "standard" });
    void pending.catch(() => undefined);
    const reply = await (await post(paths.socket, "/next", {}, secret)).json() as { job: BridgeJob };
    expect(reply.job).toEqual({ kind: "builtin", id: 1, tool: "WebSearch", input: { query: "pi fabric", mode: "standard" } });
    const value = { result: { query: "pi fabric", results: [] }, text: "No results." };
    expect(await (await answer(paths.socket, secret, { id: 1, ok: true, result: value })).json()).toEqual({ ok: true });
    expect(await pending).toEqual(value);
  });

  test("a built-in tool call fails at once when no mod ever polled, naming the built-in tools", async () => {
    const { bridge } = await serve();
    await expect(bridge.tool("WebSearch", { query: "x" }))
      .rejects.toThrow("no Fabric mod is connected in this session, so Claude Code's built-in tools cannot be reached");
  });

  test("takes a call while the mod's poll is parked, and answers in the same poll", async () => {
    const { bridge, paths } = await serve({ pollMs: 2000 });
    const secret = await secretOf(paths);
    const poll = post(paths.socket, "/next", {}, secret);
    await Bun.sleep(20); // the poll is parked, waiting for work
    const pending = bridge.call("context7", "resolve-library-id", { libraryName: "react" });
    void pending.catch(() => undefined);
    const reply = await (await poll).json() as { job: { id: number; server: string } };
    expect(reply.job.server).toBe("context7");
    await answer(paths.socket, secret, { id: reply.job.id, ok: true, result: { content: [{ type: "text", text: "done" }] } });
    expect(await pending).toEqual({ content: [{ type: "text", text: "done" }] });
  });

  test("carries a failure the mod reports as the call's rejection", async () => {
    const { bridge, paths } = await serve({ pollMs: 200 });
    const secret = await secretOf(paths);
    await post(paths.socket, "/next", {}, secret);
    const pending = bridge.call("context7", "resolve-library-id", {});
    void pending.catch(() => undefined);
    const reply = await (await post(paths.socket, "/next", {}, secret)).json() as { job: { id: number } };
    expect(await (await answer(paths.socket, secret, { id: reply.job.id, ok: false, error: "sign-in needed" })).json()).toEqual({ ok: true });
    await expect(pending).rejects.toThrow("sign-in needed");
  });

  test("fails at once when no mod ever polled", async () => {
    const { bridge } = await serve();
    const start = performance.now();
    await expect(bridge.call("context7", "x", {})).rejects.toThrow("no Fabric mod is connected in this session");
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test("a built-in tool call fails at its own limit when the mod stops answering", async () => {
    const { bridge, paths } = await serve({ pollMs: 20, answerTimeoutMs: 120 });
    await post(paths.socket, "/next", {}, await secretOf(paths)); // the mod is here, and takes nothing
    await expect(bridge.tool("WebSearch", { query: "x" })).rejects.toThrow("did not answer within 120ms");
  });

  test("fails at its own limit when the mod stops answering", async () => {
    const { bridge, paths } = await serve({ pollMs: 20, answerTimeoutMs: 120 });
    const secret = await secretOf(paths);
    await post(paths.socket, "/next", {}, secret); // the mod is there, and takes nothing
    await expect(bridge.call("context7", "x", {})).rejects.toThrow("did not answer within 120ms");
  });

  test("replaces a stale socket at start, and close removes its socket, secret and lock", async () => {
    const dir = await folder();
    const paths = bridgePaths(dir, "stale");
    await mkdir(paths.dir, { recursive: true });
    await Bun.write(paths.socket, "left by an earlier process");
    const started = await startBridge({ pluginData: dir, sessionId: "stale", pollMs: 20 });
    if (!("bridge" in started)) throw new Error(started.error);
    bridges.push(started.bridge);
    expect(await (await post(paths.socket, "/next", {}, await secretOf(paths))).json()).toEqual({ job: null });
    started.bridge.close();
    expect(await Bun.file(paths.socket).exists()).toBe(false);
    expect(await Bun.file(paths.secret).exists()).toBe(false);
    expect(await Bun.file(paths.lock).exists()).toBe(false);
  });

  test("fails to start, with the reason, when the session has no folder or a path too long", async () => {
    expect(await startBridge({ pluginData: "", sessionId: "s" })).toEqual({
      error: "CLAUDE_PLUGIN_DATA is not set, so the Fabric mod and the server have no folder to meet in",
    });
    expect(await startBridge({ pluginData: "/tmp", sessionId: "" })).toEqual({
      error: "CLAUDE_CODE_SESSION_ID is not set, so the bridge has no socket name for this session",
    });
    const long = await startBridge({ pluginData: "/" + "x".repeat(SOCKET_PATH_LIMIT), sessionId: "s" });
    if (!("error" in long)) throw new Error("a path over the limit must not start a bridge");
    expect(long.error).toContain("over the Unix socket limit");
  });

  test("never hands out a job whose call already gave up", async () => {
    const { bridge, paths } = await serve({ pollMs: 20, answerTimeoutMs: 120 });
    const secret = await secretOf(paths);
    await post(paths.socket, "/next", {}, secret); // the mod is here; its poll took nothing
    await expect(bridge.call("context7", "write", { n: 1 })).rejects.toThrow("did not answer within 120ms");
    // The call was reported as failed; the job it queued must not run after that.
    expect(await (await post(paths.socket, "/next", {}, secret)).json()).toEqual({ job: null });
  });

  test("a poll that disconnects takes no later job", async () => {
    const { bridge, paths } = await serve({ pollMs: 1000, answerTimeoutMs: 2000 });
    const secret = await secretOf(paths);
    await expect(post(paths.socket, "/next", {}, secret, AbortSignal.timeout(50))).rejects.toThrow();
    await Bun.sleep(100); // the server has seen the disconnect
    const pending = bridge.call("context7", "resolve-library-id", { libraryName: "react" });
    void pending.catch(() => undefined);
    const reply = await (await post(paths.socket, "/next", {}, secret)).json() as { job: { id: number; server: string; tool: string } | null };
    expect(reply.job?.server).toBe("context7");
    expect(reply.job?.tool).toBe("resolve-library-id");
    await answer(paths.socket, secret, { id: reply.job?.id, ok: true, result: { content: [{ type: "text", text: "ok" }] } });
    expect(await pending).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  test("refuses a second start while the first holds the lock, and the first still answers", async () => {
    const first = await serve({ pollMs: 20 });
    const secret = await secretOf(first.paths);
    expect(await Bun.file(first.paths.lock).text()).toBe(String(process.pid));
    const started: BridgeStart = await startBridge({ pluginData: first.dir, sessionId: "s1", pollMs: 20 });
    if (!("error" in started)) {
      started.bridge.close();
      throw new Error("a second start while the lock is held must be refused");
    }
    expect(started.error).toContain("already listening");
    // The refused start changed nothing: the first still owns its secret and answers.
    expect(await secretOf(first.paths)).toBe(secret);
    expect(await (await post(first.paths.socket, "/next", {}, secret)).json()).toEqual({ job: null });
  });

  test("takes over a lock a dead process left", async () => {
    const dir = await folder();
    const paths = bridgePaths(dir, "left");
    await mkdir(paths.dir, { recursive: true });
    const child = Bun.spawn(["/bin/true"]);
    const deadPid = child.pid;
    await child.exited;
    await Bun.write(paths.lock, String(deadPid));
    await Bun.write(paths.socket, "left by the dead process");
    const started = await startBridge({ pluginData: dir, sessionId: "left", pollMs: 20 });
    if (!("bridge" in started)) throw new Error(started.error);
    bridges.push(started.bridge);
    expect(await Bun.file(paths.lock).text()).toBe(String(process.pid));
    expect(await (await post(paths.socket, "/next", {}, await secretOf(paths))).json()).toEqual({ job: null });
  });

  test("refuses a lock whose text is not a pid, and leaves it in place", async () => {
    const dir = await folder();
    const paths = bridgePaths(dir, "odd");
    await mkdir(paths.dir, { recursive: true });
    await Bun.write(paths.lock, "not a pid\n");
    const started = await startBridge({ pluginData: dir, sessionId: "odd", pollMs: 20 });
    if (!("error" in started)) {
      started.bridge.close();
      throw new Error("a lock that names no pid is no proof its owner is gone");
    }
    expect(started.error).toContain("holds no pid");
    expect(await Bun.file(paths.lock).text()).toBe("not a pid\n");
    expect(await Bun.file(paths.secret).exists()).toBe(false);
  });

  test("a second close leaves a successor's secret and lock alone", async () => {
    const dir = await folder();
    const paths = bridgePaths(dir, "twice");
    const first = await startBridge({ pluginData: dir, sessionId: "twice", pollMs: 20 });
    if (!("bridge" in first)) throw new Error(first.error);
    first.bridge.close();
    const next = await startBridge({ pluginData: dir, sessionId: "twice", pollMs: 20 });
    if (!("bridge" in next)) throw new Error(next.error);
    bridges.push(next.bridge);
    const secret = await secretOf(paths);
    first.bridge.close(); // the signal handler, then exit
    expect(await Bun.file(paths.lock).exists()).toBe(true);
    expect(await secretOf(paths)).toBe(secret);
  });
});
