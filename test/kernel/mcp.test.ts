// One program's mcp call: the access rule's verdict, the job it may send, and the value or error
// that comes back. The laws behind the verdict are proved in proofs/mcp-access.ts.
import { describe, expect, test } from "bun:test";
import { callMcp, mcpValue, type McpLink } from "../../src/kernel/mcp.ts";
import { MCP_REF } from "../../src/kernel/protocol.ts";
import { mcpAccessVerdict } from "../../src/kernel/verified/mcp-access.ts";
import type { McpCatalog } from "../../src/registry/mcp.ts";

const CATALOG: McpCatalog = {
  servers: [
    { server: "context7", tools: [{ name: "resolve-library-id" }] },
    { server: "claude.ai Gmail", tools: [{ name: "list_messages" }] },
  ],
};

interface Sent { server: string; tool: string; args: Record<string, unknown> }

function link(catalog: McpCatalog = CATALOG, result: unknown = { content: [{ type: "text", text: "ok" }], isError: false }): { value: McpLink; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    value: {
      catalog: () => catalog,
      call: async (server, tool, args) => {
        sent.push({ server, tool, args });
        return result;
      },
    },
  };
}

describe("the verified access rule", () => {
  test("allows a pair the catalog holds and sends one job", () => {
    expect(mcpAccessVerdict(true, false)).toEqual({ allow: true, jobs: 1 });
  });

  test("refuses a pair it does not hold, and our own server, sending no job", () => {
    expect(mcpAccessVerdict(false, false)).toEqual({ allow: false, jobs: 0 });
    expect(mcpAccessVerdict(true, true)).toEqual({ allow: false, jobs: 0 });
    expect(mcpAccessVerdict(false, true)).toEqual({ allow: false, jobs: 0 });
  });
});

describe("an MCP result as a program's value", () => {
  test("joins the text blocks and keeps the structured content when the server sent one", () => {
    const result = { content: [{ type: "text", text: "one" }, { type: "text", text: "two" }, { type: "image", mimeType: "image/png" }], isError: false, structuredContent: { id: 7 } };
    expect(mcpValue(result, "mcp.s.t")).toEqual({ text: "one\ntwo", structuredContent: { id: 7 } });
  });

  test("omits structured content the server did not send", () => {
    expect(mcpValue({ content: [{ type: "text", text: "only" }], isError: false }, "mcp.s.t")).toEqual({ text: "only" });
  });

  test("rejects a result the server marked as an error, with its own text", () => {
    expect(() => mcpValue({ content: [{ type: "text", text: "needs sign-in" }], isError: true }, "mcp.s.t")).toThrow("needs sign-in");
    expect(() => mcpValue({ content: [], isError: true }, "mcp.s.t")).toThrow("mcp.s.t: the MCP tool returned an error");
  });

  test("answers a result that is not an MCP result with empty text, not a crash", () => {
    expect(mcpValue(undefined, "mcp.s.t")).toEqual({ text: "" });
  });
});

describe("one program's mcp call", () => {
  test("sends the raw server and tool names the catalog resolved", async () => {
    const fake = link();
    expect(await callMcp(fake.value, ["claude_ai_Gmail", "list_messages", { limit: 3 }]))
      .toEqual({ text: "ok" });
    expect(fake.sent).toEqual([{ server: "claude.ai Gmail", tool: "list_messages", args: { limit: 3 } }]);
  });

  test("takes no arguments as an empty record", async () => {
    const fake = link();
    await callMcp(fake.value, ["context7", "resolve-library-id"]);
    expect(fake.sent).toEqual([{ server: "context7", tool: "resolve-library-id", args: {} }]);
  });

  test("refuses this plugin's own server before any job", async () => {
    const fake = link();
    await expect(callMcp(fake.value, ["fabric", "fabric_exec", { code: "return 1" }]))
      .rejects.toThrow("mcp.fabric.fabric_exec: the fabric server is this session's own fabric_exec and cannot be called from a program");
    expect(fake.sent).toEqual([]);
  });

  test("names the server and the tools a call could have used", async () => {
    const fake = link();
    await expect(callMcp(fake.value, ["context7", "nope"]))
      .rejects.toThrow('mcp.context7.nope: MCP server "context7" has no tool named "nope". Tools: resolve-library-id.');
    await expect(callMcp(fake.value, ["nowhere", "x"]))
      .rejects.toThrow('mcp.nowhere.x: no MCP server named "nowhere" is connected in this session. Connected: context7, claude.ai Gmail.');
    const empty = link({ servers: [] });
    await expect(callMcp(empty.value, ["nowhere", "x"])).rejects.toThrow("no MCP server is connected in this session, and the Fabric mod has sent no catalog");
    expect(fake.sent).toEqual([]);
  });

  test("refuses a key two servers spell, and sends nothing", async () => {
    const fake = link({ servers: [{ server: "a.b", tools: [{ name: "one" }] }, { server: "a-b", tools: [{ name: "one" }] }] });
    await expect(callMcp(fake.value, ["a_b", "one"])).rejects.toThrow("more than one connected MCP server spells");
    expect(fake.sent).toEqual([]);
  });

  test("refuses arguments that are not one object", async () => {
    const fake = link();
    await expect(callMcp(fake.value, ["context7", "resolve-library-id", "react"]))
      .rejects.toThrow("mcp.context7.resolve-library-id: the tool arguments must be one object");
    expect(fake.sent).toEqual([]);
  });

  test("reports why no bridge can answer, and rejects a result the server marked as an error", async () => {
    const running = link(CATALOG, { content: [{ type: "text", text: "no token" }], isError: true });
    await expect(callMcp(running.value, ["context7", "resolve-library-id"])).rejects.toThrow("no token");
    const broken: McpLink = {
      catalog: () => ({ servers: [] }),
      call: () => Promise.reject(new Error("unused")),
      error: "CLAUDE_PLUGIN_DATA is not set, so the Fabric mod and the server have no folder to meet in",
    };
    await expect(callMcp(broken, ["context7", "x"])).rejects.toThrow("mcp.context7.x: CLAUDE_PLUGIN_DATA is not set");
    await expect(callMcp(undefined, ["context7", "x"])).rejects.toThrow("mcp.context7.x: mcp calls need the Fabric mod");
  });

  test("the call crosses the bridge under the mcp ref", () => {
    expect(MCP_REF).toBe("mcp");
  });
});
