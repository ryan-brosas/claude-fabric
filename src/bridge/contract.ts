// The contract between the two halves of the socket. The server process listens on it; the mod,
// inside Claude Code, is its client. Both sides build the same paths and send the same JSON, so
// neither can drift from the other, and a test can move the whole bridge into a temporary folder.

import { bridgeBindingVerdict } from "../kernel/verified/bridge-binding.ts";

/** The header every request carries: the per-session secret the server wrote beside the socket. */
export const BRIDGE_HEADER = "x-fabric-bridge";

/**
 * The longest socket path both sides accept, in chars. Linux allows 108 bytes including the
 * terminating NUL and macOS 104. Below that, both sides refuse a longer path with a clear message
 * instead of a failed bind or a fetch with no explanation.
 */
export const SOCKET_PATH_LIMIT = 100;

/** How long the mod's long poll waits for a job before asking again. */
export const JOB_WAIT_MS = 15_000;

/** How long the mod waits before retrying a socket that is not up yet. */
export const RETRY_MS = 250;

export interface BridgePaths {
  /** The bridge folder beside the plugin's data, created 0700. */
  dir: string;
  /** The listening socket, one per session. */
  socket: string;
  /** The secret the server writes 0600 at start and the mod reads. */
  secret: string;
  /** The lock whose holder owns the socket and the secret, one per session. */
  lock: string;
}

/** How many characters of the session id name its files: 80 bits of a UUID, short enough for the socket limit. */
const SESSION_NAME_CHARS = 20;

/**
 * Where one session's socket, secret and lock live under the plugin's data directory. The files
 * are named by the session id's first letters and digits, not the whole id: an installed plugin's
 * data folder is long enough that a full UUID puts the socket over the Unix limit. Two live
 * sessions that share a name cannot both own it; the lock refuses the second.
 */
export function bridgePaths(pluginData: string, sessionId: string): BridgePaths {
  const dir = pluginData.replace(/\/+$/, "") + "/bridge";
  const name = sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, SESSION_NAME_CHARS);
  return {
    dir,
    socket: dir + "/" + name + ".sock",
    secret: dir + "/" + name + ".key",
    lock: dir + "/" + name + ".lock",
  };
}

/** What the server writes to the secret file: the full session id, then the secret. */
export const secretFileText = (sessionId: string, secret: string): string => sessionId + "\n" + secret + "\n";

/**
 * The secret a mod may use, or undefined. Files are named by a prefix of the session id, so a
 * file can belong to another session that shares the prefix; its secret is used only when the
 * file names this session in full (proofs/bridge-binding.ts).
 */
export function boundSecret(text: string, sessionId: string): string | undefined {
  const [owner = "", secret = ""] = text.split("\n").map((line) => line.trim());
  return bridgeBindingVerdict(sessionId !== "" && owner === sessionId, secret !== "") ? secret : undefined;
}

/** Why these paths cannot be used, or undefined when they can. Both sides ask before using them. */
export function bridgePathProblem(paths: BridgePaths): string | undefined {
  if (paths.socket.endsWith("/.sock")) return "the session id has no letters or digits to name the bridge's files by";
  if (paths.socket.length > SOCKET_PATH_LIMIT) {
    return "the bridge socket path is " + paths.socket.length + " chars, over the Unix socket limit of " +
      SOCKET_PATH_LIMIT + " (" + paths.socket + "); point CLAUDE_PLUGIN_DATA at a shorter path";
  }
  return undefined;
}

/** One tool of one connected MCP server, as the session's tool list names it. */
export interface BridgeTool {
  name: string;
  description?: string;
}

/** One connected MCP server and its tools. */
export interface BridgeServer {
  /** The server's name in the tool list's spelling, mcp__<server>__<tool>, which the mod's call accepts. */
  server: string;
  tools: readonly BridgeTool[];
}

/** The session's connected MCP servers, this plugin's own excluded: what a program may call. */
export interface BridgeCatalog {
  servers: readonly BridgeServer[];
}

/** One job the mod runs: a connected MCP server's tool, or a built-in tool Claude Code owns. */
export type BridgeJob = McpJob | BuiltinJob;

export interface McpJob {
  kind: "mcp";
  id: number;
  /** The server's name in the tool list's spelling, which `$.mcp.call` accepts. */
  server: string;
  /** The tool's raw name, as the server spells it. */
  tool: string;
  args: Record<string, unknown>;
}

/**
 * One built-in tool Claude Code runs: `$.tool.call({ tool, ...input })`. Only a name in
 * `BUILTIN_TOOLS` ever gets one, and the mod refuses any other name it is handed.
 */
export interface BuiltinJob {
  kind: "builtin";
  id: number;
  tool: string;
  input: Record<string, unknown>;
}

/**
 * The built-in tools a program may call through the mod. This plugin's `fabric_exec` skips the
 * person's permission prompts and deny rules when `$.tool.call` runs a tool, so the list is
 * fixed and holds only what a person would expect a search program to reach. The host sends a
 * job only for one of these, and the mod runs only one of these: two walls, one list.
 */
export const BUILTIN_TOOLS: readonly string[] = ["WebSearch"];

/** Whether the fixed list holds this built-in tool. */
export const isBuiltinTool = (name: string): boolean => BUILTIN_TOOLS.includes(name);

export type BridgeAnswer =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export interface BridgeNext {
  job: BridgeJob | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a body is a catalog the server can hold. A malformed one would poison the checker. */
export function isBridgeCatalog(value: unknown): value is BridgeCatalog {
  if (!isObject(value) || !Array.isArray(value.servers)) return false;
  return value.servers.every((entry) => {
    if (!isObject(entry) || typeof entry.server !== "string" || !Array.isArray(entry.tools)) return false;
    return entry.tools.every((tool) =>
      isObject(tool) && typeof tool.name === "string" && (tool.description === undefined || typeof tool.description === "string"));
  });
}

/** This plugin's own server, in both spellings a call can use: the manifest key and the tool one. */
export function isFabricServer(name: string): boolean {
  return name === "fabric" || name.startsWith("plugin_fabric_");
}

/** The prefix Claude Code puts on an MCP tool's wire name. */
const MCP_TOOL_PREFIX = "mcp__";

/**
 * mcp__<server>__<tool> split at the first __ after the prefix. A second __ that overlaps or
 * follows it means the boundary is unknowable from the name alone: it could be a server whose wire
 * name holds __, or a tool that does. mcp__a___t is server a, tool _t and also server a_, tool t,
 * and only one separator can be counted. Such a name answers undefined, so the mod leaves it out
 * of the catalog instead of guessing a server and a tool that were never connected.
 */
export function splitMcpToolName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return undefined;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const at = rest.indexOf("__");
  if (at <= 0 || at + 2 >= rest.length) return undefined;
  // Three underscores in a row are two separators sharing one, so the first is not the boundary.
  if (rest.startsWith("___", at)) return undefined;
  const tool = rest.slice(at + 2);
  if (tool.includes("__")) return undefined;
  return { server: rest.slice(0, at), tool };
}
