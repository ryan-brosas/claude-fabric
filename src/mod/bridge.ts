// The mod's pure half: the catalog a tool list makes, the requests to post, the job a poll carries
// and the answer to give it. Each function takes plain data and answers plain data, and none of
// them names `$`: the hooks compiler refuses a `$` bound, passed, spread, returned or read, so
// every `$.noun.method(...)` is spelled at the call site inside a hook body in index.ts, and this
// file is what those bodies call.

import type { ToolInfo } from "claude-code";
import {
  BRIDGE_HEADER,
  BUILTIN_TOOLS,
  RETRY_MS,
  isFabricServer,
  splitMcpToolName,
  type BridgeAnswer,
  type BridgeCatalog,
  type BridgeJob,
  type BridgePaths,
} from "../bridge/contract.ts";

/** The longest the loop waits between tries, so a socket that comes back is found in seconds. */
const RETRY_MAX_MS = 4000;

/** What the mod carries between hook bodies: the catalog, and the version the server holds. */
export interface BridgeState {
  catalog: BridgeCatalog | undefined;
  /** Raised by every tool list: the loop publishes a version the server has not taken. */
  version: number;
  /** The version the server last took; -1 while no version is known to belong to its secret. */
  posted: number;
  /** The secret the posted mark belongs to: a restarted server writes a new one and holds no catalog. */
  secret: string | undefined;
}

export const emptyState = (): BridgeState => ({ catalog: undefined, version: 0, posted: 0, secret: undefined });

/** The session's tool list recorded as the next version to publish. */
export const notedTools = (state: BridgeState, tools: readonly ToolInfo[]): BridgeState =>
  ({ catalog: catalogOf(tools), version: state.version + 1, posted: state.posted, secret: state.secret });

/**
 * The state once the secret read is the one this server wrote. A new secret means a restarted
 * server, whose catalog starts empty: the posted mark from the old server says nothing about it,
 * so the next poll publishes the catalog again.
 */
export const notedSecret = (state: BridgeState, secret: string): BridgeState =>
  (state.secret === secret ? state : { ...state, secret, posted: -1 });

/** The state after the server took `version`. */
export const markedPosted = (state: BridgeState, version: number): BridgeState =>
  (state.posted === version ? state : { ...state, posted: version });

/** The catalog a session's tool list makes: its MCP tools, minus this plugin's own server. */
export function catalogOf(tools: readonly ToolInfo[]): BridgeCatalog {
  const servers = new Map<string, { name: string; description?: string }[]>();
  for (const tool of tools) {
    if (!tool.mcp) continue;
    const split = splitMcpToolName(tool.name);
    if (split === undefined || isFabricServer(split.server)) continue;
    const entry = tool.description === undefined || tool.description === ""
      ? { name: split.tool }
      : { name: split.tool, description: tool.description };
    const list = servers.get(split.server);
    if (list === undefined) servers.set(split.server, [entry]);
    else list.push(entry);
  }
  return { servers: [...servers].map(([server, list]) => ({ server, tools: list })) };
}

/** One POST over the session's socket, in the shape `$.http.fetch` takes. */
export interface BridgeRequest {
  url: string;
  init: { method: "POST"; headers: Record<string, string>; body: string; socketPath: string };
}

export function requestOf(path: string, secret: string, body: unknown, paths: BridgePaths): BridgeRequest {
  return {
    url: "http://bridge" + path,
    init: {
      method: "POST",
      headers: { [BRIDGE_HEADER]: secret, "content-type": "application/json" },
      body: JSON.stringify(body),
      socketPath: paths.socket,
    },
  };
}

/** What to post while the server holds an older catalog, or nothing when it holds this one. */
export function publishPlan(state: BridgeState): { path: string; body: BridgeCatalog; version: number } | undefined {
  if (state.catalog === undefined || state.posted === state.version) return undefined;
  return { path: "/catalog", body: state.catalog, version: state.version };
}

const objectOrEmpty = (value: unknown): Record<string, unknown> =>
  (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});

/**
 * The job a poll's body carries, or undefined while the poll found none. Two kinds ride the one
 * queue: an MCP call, which the mod runs with `$.mcp.call`, and a built-in tool call, which it
 * runs with `$.tool.call`. A body of neither shape is no job.
 */
export const jobOf = (text: string): BridgeJob | undefined => {
  try {
    const body = JSON.parse(text) as { job?: unknown };
    const job = body.job;
    if (typeof job !== "object" || job === null) return undefined;
    const record = job as Record<string, unknown>;
    if (typeof record.id !== "number" || typeof record.tool !== "string") return undefined;
    if (record.kind === "mcp") {
      if (typeof record.server !== "string") return undefined;
      return { kind: "mcp", id: record.id, server: record.server, tool: record.tool, args: objectOrEmpty(record.args) };
    }
    if (record.kind === "builtin") {
      return { kind: "builtin", id: record.id, tool: record.tool, input: objectOrEmpty(record.input) };
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * Why the mod refuses a built-in job: the tool is not on the host's fixed list. The host never
 * sends one; the mod checks again so a host bug is not a second way to a tool that skips the
 * person's permission prompts and deny rules.
 */
export const refusedBuiltin = (tool: string): string =>
  "the Fabric mod runs no built-in tool named " + JSON.stringify(tool) + "; a program may call only " +
  BUILTIN_TOOLS.join(", ");

/**
 * Whether the server accepted the mod's receipt for a job: only then does the mod run it. A job
 * the server already failed (its receipt limit passed) or never handed out is not run, so no call
 * a program gave up on runs late.
 */
export const receiptAccepted = (text: string): boolean => {
  try {
    return (JSON.parse(text) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
};

/** The answer to a job the mod ran: Claude Code's own MCP result, untouched. */
export const answerOf = (id: number, result: unknown): BridgeAnswer => ({ id, ok: true, result });

/** The answer to a job whose call threw. */
export const failureOf = (id: number, error: unknown): BridgeAnswer => ({ id, ok: false, error: reasonOf(error) });

/** A rejection's text, as an answer carries it. */
export const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** How long to wait before asking the socket again, after `attempt` failures in a row. */
export const retryDelay = (attempt: number): number =>
  Math.min(RETRY_MS * 2 ** Math.max(0, Math.min(attempt, 5)), RETRY_MAX_MS);
