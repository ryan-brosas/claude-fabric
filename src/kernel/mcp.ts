import { catalogServers, catalogTools, resolveMcp, type McpCatalog } from "../registry/mcp.ts";
import { mcpAccessVerdict } from "./verified/mcp-access.ts";

// One program's mcp.<server>.<tool>(args): the access rule decides whether a job goes to the mod,
// the bridge carries it, and the answer comes back as the call's value. Nothing here talks MCP:
// the mod runs the call through Claude Code's own connection.

/** What a run needs from the server process: the session's catalog and the socket to the mod. */
export interface McpLink {
  /** The session's catalog, as the mod last sent it. */
  catalog(): McpCatalog;
  /** One job to the mod, resolving its raw MCP result. */
  call(server: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** Why no mcp call can run at all, when the bridge did not start. */
  error?: string;
}

/** What an MCP result becomes inside a program. */
export interface McpValue {
  /** The result's text blocks, joined by newlines. */
  text: string;
  /** The server's structured result, when it sent one. */
  structuredContent?: unknown;
}

const line = (serverKey: string, toolKey: string): string => "mcp." + serverKey + "." + toolKey;

/**
 * The value a program receives: the MCP result's text blocks joined, and its structuredContent
 * when the server sent one. A result the server marks as an error throws, so a program can catch it.
 */
export function mcpValue(result: unknown, name: string): McpValue {
  const record: Record<string, unknown> = typeof result === "object" && result !== null ? result as Record<string, unknown> : {};
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content
    .filter((block): block is { type: string; text: string } =>
      typeof block === "object" && block !== null &&
      (block as Record<string, unknown>).type === "text" && typeof (block as Record<string, unknown>).text === "string")
    .map((block) => block.text)
    .join("\n");
  if (record.isError === true) throw new Error(text === "" ? name + ": the MCP tool returned an error" : text);
  return record.structuredContent === undefined ? { text } : { text, structuredContent: record.structuredContent };
}

/** Why a call the rule refused never became a job, in the call's own terms. */
function refusal(link: McpLink, serverKey: string, toolKey: string): string {
  const name = line(serverKey, toolKey);
  if (link.error !== undefined) return name + ": " + link.error;
  const catalog = link.catalog();
  const resolution = resolveMcp(catalog, serverKey, toolKey);
  switch (resolution.kind) {
    case "own":
      return name + ": the fabric server is this session's own fabric_exec and cannot be called from a program";
    case "ambiguous-server":
      return name + ": more than one connected MCP server spells " + JSON.stringify(serverKey) + " in code; call one by its exact name in brackets, like mcp[\"the exact name\"][\"the tool\"]";
    case "no-server": {
      const servers = catalogServers(catalog);
      // An empty catalog is the mod never having sent one: say so, instead of blaming the name.
      if (servers.length === 0) {
        return name + ": no MCP server is connected in this session, and the Fabric mod has sent no catalog; nothing can be called";
      }
      return name + ": no MCP server named " + JSON.stringify(serverKey) + " is connected in this session. Connected: " + servers.join(", ") + ".";
    }
    case "ambiguous-tool":
      return name + ": more than one tool of " + JSON.stringify(resolution.server) + " spells " + JSON.stringify(toolKey) + " in code; call one by its exact name in brackets";
    case "no-tool": {
      const tools = catalogTools(catalog, resolution.server);
      return name + ": MCP server " + JSON.stringify(resolution.server) + " has no tool named " + JSON.stringify(toolKey) + "." +
        (tools.length === 0 ? " It lists no tools." : " Tools: " + tools.join(", ") + ".");
    }
    default:
      return name + ": the call is not allowed";
  }
}

/** Runs one program call: the access rule first, then one job to the mod, then the call's value. */
export async function callMcp(link: McpLink | undefined, args: unknown[]): Promise<McpValue> {
  const serverKey = typeof args[0] === "string" ? args[0] : String(args[0]);
  const toolKey = typeof args[1] === "string" ? args[1] : String(args[1]);
  const name = line(serverKey, toolKey);
  if (link === undefined) throw new Error(name + ": mcp calls need the Fabric mod, and this run has no bridge to it");
  const resolution = resolveMcp(link.catalog(), serverKey, toolKey);
  // The access rule (proofs/mcp-access.ts): only a pair the session's catalog holds, and never
  // this plugin's own server. A job leaves only through the machine's verdict.
  const verdict = mcpAccessVerdict(resolution.kind === "ok", resolution.kind === "own");
  if (resolution.kind !== "ok" || verdict.jobs !== 1) throw new Error(refusal(link, serverKey, toolKey));
  const given = args[2];
  if (given !== undefined && (typeof given !== "object" || given === null || Array.isArray(given))) {
    throw new Error(name + ": the tool arguments must be one object, like " + name + "({ field: value })");
  }
  const value = await link.call(resolution.server, resolution.tool, (given ?? {}) as Record<string, unknown>);
  return mcpValue(value, name);
}
