// The deferred tool list, shortened for a fabric session: built-ins by name, MCP tools by server.
// The hook is driven with a fake event and next, after a tool list that does or does not hold fabric_exec.
import { describe, expect, test } from "bun:test";
import { FABRIC_EXEC_TOOL } from "../../src/guidance/guidance.ts";
import { DEFERRED_HEADER, compactDeferred } from "../../src/mod/deferred.ts";
import { register } from "../../src/mod/index.ts";

const ready = "The following tools just became available and are ready to use:\nmcp__docs__guide";
const deferredSection = [
  DEFERRED_HEADER + " Their schemas are NOT loaded. Use ToolSearch with query \"select:<name>\" to load them:",
  "CronCreate",
  "WebSearch",
  ...Array.from({ length: 30 }, (_, index) => `mcp__mail__tool_number_${index}`),
  "mcp__docs__create",
  "mcp__docs__delete",
  "mcp__plugin_easel_easel__chart",
].join("\n");
const pending = "The following MCP servers are still connecting:\nnotes";
const delta = [ready, deferredSection, pending].join("\n\n");

describe("compactDeferred", () => {
  test("lists built-ins by name and MCP servers by prefix and count", () => {
    const sections = compactDeferred(delta).split("\n\n");
    expect(sections[0]).toBe(ready);
    expect(sections[2]).toBe(pending);
    expect(sections[1]!.split("\n").slice(1)).toEqual([
      "CronCreate",
      "WebSearch",
      "mcp__mail__* (30 tools)",
      "mcp__docs__* (2 tools)",
      "mcp__plugin_easel_easel__* (1 tool)",
    ]);
    expect(sections[1]).toContain("ToolSearch");
    // The program route to an MCP tool, which loads no schema.
    expect(sections[1]).toContain("mcp.<server>.<tool>(args)");
    expect(compactDeferred(delta).length).toBeLessThan(delta.length / 2);
  });

  test("leaves a text with no deferred section, or one it cannot read, as it is", () => {
    expect(compactDeferred(ready)).toBe(ready);
    const odd = [ready, DEFERRED_HEADER + " x\nmcp__a__b\nnot a tool name"].join("\n\n");
    expect(compactDeferred(odd)).toBe(odd);
    const empty = DEFERRED_HEADER + " x";
    expect(compactDeferred(empty)).toBe(empty);
  });

  test("never makes the text longer", () => {
    const one = DEFERRED_HEADER + " x\nmcp__a__b";
    expect(compactDeferred(one)).toBe(one);
  });
});

type Handler = (dollar: unknown, event: unknown, next: (event: unknown) => unknown) => unknown;

function hooks(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const on = (topic: string, ...rest: unknown[]) => {
    handlers.set(topic, rest.at(-1) as Handler);
    return { catch: () => undefined };
  };
  register(on as never, {} as never);
  return handlers;
}

const engine = { kind: "engine" };
const listOf = (names: string[]) => ({ value: names.map((name) => ({ name, description: "", mcp: true })) });

describe("the prompt.attachment hook", () => {
  test("shortens the list once a tool list holds fabric_exec", async () => {
    const h = hooks();
    await h.get("tool.list")!({}, {}, () => listOf([FABRIC_EXEC_TOOL, "Bash"]));
    const result = await h.get("prompt.attachment")!({}, { type: "deferred_tools_delta", text: delta, origin: engine }, () => ({ text: delta }));
    expect(result).toEqual({ text: compactDeferred(delta) });
  });

  test("passes the list through without fabric_exec, before any tool list, or for text it did not write", async () => {
    const before = hooks();
    const event = { type: "deferred_tools_delta", text: delta, origin: engine };
    expect(await before.get("prompt.attachment")!({}, event, () => ({ text: delta }))).toEqual({ text: delta });

    const without = hooks();
    await without.get("tool.list")!({}, {}, () => listOf(["Bash"]));
    expect(await without.get("prompt.attachment")!({}, event, () => ({ text: delta }))).toEqual({ text: delta });

    const withFabric = hooks();
    await withFabric.get("tool.list")!({}, {}, () => listOf([FABRIC_EXEC_TOOL]));
    const hookText = { ...event, origin: { kind: "hook", event: "SessionStart" } };
    expect(await withFabric.get("prompt.attachment")!({}, hookText, () => ({ text: delta }))).toEqual({ text: delta });
    expect(await withFabric.get("prompt.attachment")!({}, event, () => ({ text: null }))).toEqual({ text: null });
  });
});
