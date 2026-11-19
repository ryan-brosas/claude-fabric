// One program's call to a built-in tool Claude Code owns: the access rule's verdict, the one job it
// may send, and the answer that comes back. The laws behind the verdict are proved in
// proofs/builtin-access.ts.
import { describe, expect, test } from "bun:test";
import { BUILTIN_TOOLS } from "../../src/bridge/contract.ts";
import { builtinTools, callBuiltin, type BuiltinLink } from "../../src/kernel/builtin.ts";
import { builtinAccessVerdict } from "../../src/kernel/verified/builtin-access.ts";

interface Sent { tool: string; input: Record<string, unknown> }

function link(value: unknown = { result: { query: "x", results: [] }, text: "ok" }): { value: BuiltinLink; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    value: {
      tool: async (tool, input) => {
        sent.push({ tool, input });
        return value;
      },
    },
  };
}

describe("the verified access rule", () => {
  test("allows the tool the fixed allowlist holds, and sends one job", () => {
    expect(builtinAccessVerdict(true)).toEqual({ allow: true, jobs: 1 });
  });

  test("refuses every other tool and sends no job", () => {
    expect(builtinAccessVerdict(false)).toEqual({ allow: false, jobs: 0 });
  });

  test("the allowlist holds WebSearch and nothing else", () => {
    expect(BUILTIN_TOOLS).toEqual(["WebSearch"]);
  });
});

describe("one program's built-in call", () => {
  test("sends exactly one job for the allowlisted tool, with the input it was given", async () => {
    const fake = link();
    expect(await callBuiltin(fake.value, "WebSearch", { query: "pi fabric", mode: "standard" }))
      .toEqual({ result: { query: "x", results: [] }, text: "ok" });
    expect(fake.sent).toEqual([{ tool: "WebSearch", input: { query: "pi fabric", mode: "standard" } }]);
  });

  test("refuses a tool the allowlist does not hold, and sends nothing", async () => {
    for (const name of ["Agent", "Read", "Bash", "WebFetch"]) {
      const fake = link();
      await expect(callBuiltin(fake.value, name, { query: "x" })).rejects.toThrow(
        name + ': a program may not call "' + name + '" through the Fabric mod; it may call only WebSearch.',
      );
      expect({ name, sent: fake.sent }).toEqual({ name, sent: [] });
    }
  });

  test("reports why no bridge can answer, instead of waiting", async () => {
    const broken: BuiltinLink = {
      tool: () => Promise.reject(new Error("unused")),
      error: "CLAUDE_PLUGIN_DATA is not set, so the Fabric mod and the server have no folder to meet in",
    };
    await expect(callBuiltin(broken, "WebSearch", { query: "x" }))
      .rejects.toThrow("WebSearch: CLAUDE_PLUGIN_DATA is not set");
  });

  test("the link a run gets applies the same rule, and is absent with no bridge", async () => {
    const fake = link();
    const tools = builtinTools(fake.value);
    expect(await tools?.call("WebSearch", { query: "x" })).toEqual({ result: { query: "x", results: [] }, text: "ok" });
    await expect(tools?.call("Agent", { prompt: "x" })).rejects.toThrow("may not call");
    expect(fake.sent).toEqual([{ tool: "WebSearch", input: { query: "x" } }]);
    expect(builtinTools(undefined)).toBeUndefined();
  });
});
