import type { BridgeCatalog, BridgeServer, BridgeTool } from "../bridge/contract.ts";
import { isFabricServer } from "../bridge/contract.ts";

// What a program's mcp.<server>.<tool>() call sees, printed from the session's catalog the mod
// sends. The checker's declarations, the one model-facing line and the host's lookup all read this
// file, so a name the check accepts is a name the host resolves, and nothing else.

export type McpCatalog = BridgeCatalog;

// Copied from pi-fabric (MIT, Tom X Nguyen) src/ref-names.ts at d331f629: the identifier-safe
// shape the guest declarations, the proxy and the host's lookup share.
export const sanitizeRefPart = (value: string): string => {
  const sanitized = value.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(sanitized) ? sanitized : "_" + sanitized;
};

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** A key for an object type: bare when it is an identifier, quoted when it is not. */
export const propertyKey = (name: string): string => (IDENT.test(name) ? name : JSON.stringify(name));

/** Every name one server or tool answers to in code: its sanitized identifier, and its raw name when that differs. */
export function refKeys(raw: string): string[] {
  const sanitized = sanitizeRefPart(raw);
  return sanitized === raw ? [raw] : [sanitized, raw];
}

/** The model-facing line for the mcp surface: one line, no tool list. */
export const MCP_INTRO = "MCP servers connected in this session, through Claude Code's own connections:";

export const MCP_LINE =
  "- mcp.<server>.<tool>(args) -> { text, structuredContent? }. Calls a connected MCP server's tool; " +
  "the tool's text blocks come back joined, a result the server marks as an error rejects, and only " +
  "a server and tool this session lists can be called.";

const MAX_DESCRIPTION = 120;

function docLine(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  const one = description.replace(/\s+/g, " ").trim();
  if (one === "") return undefined;
  const cut = one.length > MAX_DESCRIPTION ? one.slice(0, MAX_DESCRIPTION - 3) + "..." : one;
  // A "*/" in the text would close the comment early. Escape it after the cut, so the cut cannot
  // split the escape; the escape adds a character, and only the text ever grows by it.
  return "/** " + cut.replaceAll("*/", "*\\/") + " */";
}

/**
 * The guest declarations for a catalog: one interface per server, one member per tool with both
 * spellings it answers to, then one loose fallback for a server or tool the catalog did not hold
 * when the program was written. The host still decides every call, so the fallback compiles and
 * is refused at dispatch, never a hole in the check.
 */
export function mcpTypes(catalog: McpCatalog): string {
  const blocks: string[] = ["interface McpResult { text: string; structuredContent?: unknown }"];
  const groups = new Map<string, BridgeServer[]>();
  for (const entry of catalog.servers) {
    const key = sanitizeRefPart(entry.server);
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const members: string[] = [];
  let omitted = 0;
  for (const [sanitized, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    // Two servers that spell one identifier are declared by neither shared key: an exact raw name
    // is what resolves one, so the note tells the caller to use it.
    if (group.length > 1) {
      omitted += group.length;
      continue;
    }
    const entry = group[0] as BridgeServer;
    const name = "Mcp_" + sanitized;
    const lines: string[] = ["interface " + name + " {"];
    const tools = new Map<string, BridgeTool[]>();
    for (const tool of entry.tools) {
      const key = sanitizeRefPart(tool.name);
      const bucket = tools.get(key);
      if (bucket) bucket.push(tool);
      else tools.set(key, [tool]);
    }
    for (const [toolKey, bucket] of [...tools].sort(([a], [b]) => a.localeCompare(b))) {
      if (bucket.length > 1) {
        omitted += bucket.length;
        continue;
      }
      const tool = bucket[0] as BridgeTool;
      const doc = docLine(tool.description);
      if (doc !== undefined) lines.push("  " + doc);
      const member = "(args?: Record<string, unknown>): Promise<McpResult>;";
      lines.push("  " + propertyKey(toolKey) + member);
      if (toolKey !== tool.name) lines.push("  " + propertyKey(tool.name) + member);
    }
    // A tool the catalog did not hold at this moment still compiles and is refused at dispatch,
    // so a catalog that arrives late cannot turn a working program into a type error.
    lines.push("  [tool: string]: (args?: Record<string, unknown>) => Promise<McpResult>;");
    lines.push("}");
    blocks.push(lines.join("\n"));
    members.push("  " + propertyKey(sanitized) + ": " + name + ";");
    if (sanitized !== entry.server) members.push("  " + propertyKey(entry.server) + ": " + name + ";");
  }
  const notes: string[] = [];
  if (omitted > 0) {
    notes.push("// " + omitted + " server(s) or tool(s) left out: two names spell one identifier. Call them by their raw name.");
  }
  const declared = members.length === 0 ? "{}" : "{\n" + members.join("\n") + "\n}";
  return [
    "/** The MCP servers this session has connected, through Claude Code's own connection; not this plugin's fabric_exec. */",
    ...blocks,
    ...notes,
    "declare const mcp: " + declared + " & Record<string, Record<string, (args?: Record<string, unknown>) => Promise<McpResult>>>;",
  ].join("\n");
}

/** What a program's call resolved to against one catalog. */
export type McpResolution =
  | { kind: "ok"; server: string; tool: string }
  | { kind: "own" }
  | { kind: "no-server" }
  | { kind: "ambiguous-server" }
  | { kind: "no-tool"; server: string }
  | { kind: "ambiguous-tool"; server: string };

/** Each raw name by every key it answers to, so a shared key names more than one raw name. */
function keyOwners(raw: readonly string[]): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const name of raw) {
    for (const key of refKeys(name)) {
      const list = owners.get(key);
      if (list) list.push(name);
      else owners.set(key, [name]);
    }
  }
  return owners;
}

/** What one key named: the raw name, or why it names no single one. Tagged, so a name is only ever a name. */
type Named = { ok: true; name: string } | { ok: false; reason: "none" | "ambiguous" };

/**
 * The one raw name a key names: its exact raw name first, then a sanitized alias only when no raw
 * name is spelled exactly like the key. A key two alias owners share stays ambiguous, so an
 * invented pair is refused rather than guessed. A tag, not a returned word, keeps a server or tool
 * really named "none" or "ambiguous" callable.
 */
function namedBy(raw: readonly string[], key: string): Named {
  if (raw.includes(key)) return { ok: true, name: key };
  const owners = keyOwners(raw).get(key);
  if (owners === undefined) return { ok: false, reason: "none" };
  if (owners.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, name: owners[0] as string };
}

/** The raw server and tool a program's two keys name, or why it names neither. */
export function resolveMcp(catalog: McpCatalog, serverKey: string, toolKey: string): McpResolution {
  if (isFabricServer(serverKey)) return { kind: "own" };
  const server = namedBy(catalog.servers.map((entry) => entry.server), serverKey);
  if (!server.ok) return server.reason === "none" ? { kind: "no-server" } : { kind: "ambiguous-server" };
  const entry = catalog.servers.find((candidate) => candidate.server === server.name);
  const tool = namedBy((entry?.tools ?? []).map((held) => held.name), toolKey);
  if (tool.ok) return { kind: "ok", server: server.name, tool: tool.name };
  if (tool.reason === "none") return { kind: "no-tool", server: server.name };
  return { kind: "ambiguous-tool", server: server.name };
}

/** The servers one catalog holds, for a refusal that says what could be called instead. */
export const catalogServers = (catalog: McpCatalog): string[] => catalog.servers.map((entry) => entry.server);

/** The tools one server holds, for the same. */
export const catalogTools = (catalog: McpCatalog, server: string): string[] =>
  catalog.servers.find((entry) => entry.server === server)?.tools.map((tool) => tool.name) ?? [];
