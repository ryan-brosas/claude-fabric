// What a program's mcp.<server>.<tool>() sees: the names it answers to, the declarations the
// checker serves, and the lookup the host runs. One catalog feeds all three.
import { describe, expect, test } from "bun:test";
import { STORE } from "../../src/providers/store/index.ts";
import { TOOLS } from "../../src/providers/tools/index.ts";
import { check } from "../../src/kernel/check.ts";
import { guestTypes } from "../../src/registry/generate.ts";
import {
  MCP_INTRO,
  MCP_LINE,
  catalogServers,
  catalogTools,
  mcpTypes,
  propertyKey,
  refKeys,
  resolveMcp,
  sanitizeRefPart,
  type McpCatalog,
} from "../../src/registry/mcp.ts";

const CATALOG: McpCatalog = {
  servers: [
    { server: "context7", tools: [{ name: "resolve-library-id", description: "Resolves a name to its id." }] },
    { server: "claude.ai Gmail", tools: [{ name: "list_messages" }, { name: "send.email" }] },
    { server: "a.b", tools: [{ name: "one" }] },
    { server: "a-b", tools: [{ name: "two" }] },
  ],
};

const declarations = (catalog: McpCatalog): string => guestTypes(TOOLS, STORE, [mcpTypes(catalog)]);

describe("names in code", () => {
  test("keeps an identifier and sanitizes anything else", () => {
    expect(sanitizeRefPart("context7")).toBe("context7");
    expect(sanitizeRefPart("my-server")).toBe("my_server");
    expect(sanitizeRefPart("a.b")).toBe("a_b");
    expect(sanitizeRefPart("claude.ai Gmail")).toBe("claude_ai_Gmail");
    expect(sanitizeRefPart("3d")).toBe("_3d");
  });

  test("answers to the sanitized key and the raw one", () => {
    expect(refKeys("context7")).toEqual(["context7"]);
    expect(refKeys("my-server")).toEqual(["my_server", "my-server"]);
    expect(propertyKey("my-tool")).toBe('"my-tool"');
    expect(propertyKey("tool")).toBe("tool");
  });
});

describe("the declarations", () => {
  test("print one interface per server, both keys a tool answers to, and the loose fallback", () => {
    const text = mcpTypes(CATALOG);
    expect(text).toContain("interface McpResult { text: string; structuredContent?: unknown }");
    expect(text).toContain("interface Mcp_context7 {");
    expect(text).toContain("/** Resolves a name to its id. */");
    expect(text).toContain('  resolve_library_id(args?: Record<string, unknown>): Promise<McpResult>;');
    expect(text).toContain('  "resolve-library-id"(args?: Record<string, unknown>): Promise<McpResult>;');
    expect(text).toContain('  "claude.ai Gmail": Mcp_claude_ai_Gmail;');
    expect(text).toContain('  "send.email"(args?: Record<string, unknown>): Promise<McpResult>;');
    expect(text).toContain("declare const mcp: {");
    expect(text).toContain("& Record<string, Record<string, (args?: Record<string, unknown>) => Promise<McpResult>>>;");
  });

  test("leave an ambiguous identifier out and say so", () => {
    const text = mcpTypes(CATALOG);
    expect(text).not.toContain("Mcp_a_b");
    expect(text).toContain("// 2 server(s) or tool(s) left out: two names spell one identifier");
  });

  test("declare mcp even when no server is connected", () => {
    const text = mcpTypes({ servers: [] });
    expect(text).toContain("declare const mcp: {} & Record<");
    expect(text).not.toContain("interface Mcp_");
  });

  test("compile: the sanitized key, the bracket key and the loose fallback all check, and a non-object argument does not", () => {
    const guest = declarations(CATALOG);
    expect(check('return await mcp.context7.resolve_library_id({ libraryName: "react" });', guest).ok).toBe(true);
    expect(check('return await mcp["claude.ai Gmail"]["list_messages"]();', guest).ok).toBe(true);
    expect(check("return await mcp.claude_ai_Gmail.list_messages();", guest).ok).toBe(true);
    // A server or tool the catalog did not hold still compiles, and the host refuses it at dispatch.
    expect(check("return await mcp.not_connected.anything({ a: 1 });", guest).ok).toBe(true);
    expect(check("return await mcp.context7.not_a_tool({ a: 1 });", guest).ok).toBe(true);
    // The one thing the declarations do check is the shape: one arguments object.
    expect(check('return await mcp.context7.resolve_library_id("react");', guest).ok).toBe(false);
    expect(check('return await mcp["a.b"].one({ x: 1 });', guest).ok).toBe(true);
  });

  test("say mcp.<server>.<tool> exists in one line, with no Pi name", () => {
    expect(MCP_LINE.split("\n")).toHaveLength(1);
    expect(MCP_LINE).toContain("mcp.<server>.<tool>(args)");
    expect(MCP_LINE).not.toContain("pi.");
    expect(MCP_INTRO).not.toContain("pi.");
  });
});

describe("the host's lookup", () => {
  test("resolves the sanitized key and the raw key to the same server and tool", () => {
    expect(resolveMcp(CATALOG, "context7", "resolve_library_id")).toEqual({ kind: "ok", server: "context7", tool: "resolve-library-id" });
    expect(resolveMcp(CATALOG, "context7", "resolve-library-id")).toEqual({ kind: "ok", server: "context7", tool: "resolve-library-id" });
    expect(resolveMcp(CATALOG, "claude_ai_Gmail", "send_email")).toEqual({ kind: "ok", server: "claude.ai Gmail", tool: "send.email" });
    expect(resolveMcp(CATALOG, "claude.ai Gmail", "list_messages")).toEqual({ kind: "ok", server: "claude.ai Gmail", tool: "list_messages" });
  });

  test("names what is missing, and refuses this plugin's own server first", () => {
    expect(resolveMcp(CATALOG, "nowhere", "x")).toEqual({ kind: "no-server" });
    expect(resolveMcp(CATALOG, "context7", "nope")).toEqual({ kind: "no-tool", server: "context7" });
    expect(resolveMcp(CATALOG, "fabric", "fabric_exec")).toEqual({ kind: "own" });
    expect(resolveMcp(CATALOG, "plugin_fabric_fabric", "fabric_exec")).toEqual({ kind: "own" });
  });

  test("refuses a key two raw names spell", () => {
    expect(resolveMcp(CATALOG, "a_b", "one")).toEqual({ kind: "ambiguous-server" });
    expect(resolveMcp(CATALOG, "a.b", "one")).toEqual({ kind: "ok", server: "a.b", tool: "one" });
    expect(resolveMcp(CATALOG, "a-b", "two")).toEqual({ kind: "ok", server: "a-b", tool: "two" });
  });

  test("gives an exact raw name precedence over another name's sanitized alias", () => {
    const collided: McpCatalog = {
      servers: [
        { server: "a_b", tools: [{ name: "send_email" }] },
        { server: "a-b", tools: [{ name: "send.email" }] },
      ],
    };
    expect(resolveMcp(collided, "a_b", "send_email")).toEqual({ kind: "ok", server: "a_b", tool: "send_email" });
    expect(resolveMcp(collided, "a-b", "send.email")).toEqual({ kind: "ok", server: "a-b", tool: "send.email" });
    // The sanitized alias still reaches its one owner inside a server.
    expect(resolveMcp(collided, "a-b", "send_email")).toEqual({ kind: "ok", server: "a-b", tool: "send.email" });

    const tools: McpCatalog = { servers: [{ server: "s", tools: [{ name: "send_email" }, { name: "send.email" }] }] };
    expect(resolveMcp(tools, "s", "send_email")).toEqual({ kind: "ok", server: "s", tool: "send_email" });
    expect(resolveMcp(tools, "s", "send.email")).toEqual({ kind: "ok", server: "s", tool: "send.email" });
  });

  test("calls a server or tool named none or ambiguous, not a failure sentinel", () => {
    const named: McpCatalog = {
      servers: [
        { server: "none", tools: [{ name: "ambiguous" }] },
        { server: "ambiguous", tools: [{ name: "none" }] },
      ],
    };
    expect(resolveMcp(named, "none", "ambiguous")).toEqual({ kind: "ok", server: "none", tool: "ambiguous" });
    expect(resolveMcp(named, "ambiguous", "none")).toEqual({ kind: "ok", server: "ambiguous", tool: "none" });
    // The same words still mean the failures when no name holds them.
    expect(resolveMcp(named, "nowhere", "x")).toEqual({ kind: "no-server" });
    expect(resolveMcp(named, "none", "missing")).toEqual({ kind: "no-tool", server: "none" });
  });

  test("lists what could be called instead", () => {
    expect(catalogServers(CATALOG)).toEqual(["context7", "claude.ai Gmail", "a.b", "a-b"]);
    expect(catalogTools(CATALOG, "claude.ai Gmail")).toEqual(["list_messages", "send.email"]);
    expect(catalogTools(CATALOG, "nowhere")).toEqual([]);
  });
});
