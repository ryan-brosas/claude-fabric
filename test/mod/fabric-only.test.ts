// The fabricOnly option hides the tools a program runs, and only when fabric_exec is there to take their place.
import { describe, expect, test } from "bun:test";
import { FABRIC_EXEC_TOOL } from "../../src/guidance/guidance.ts";
import { FABRIC_ONLY_OPTION, HIDDEN_TOOLS, fabricOnly, withoutProgramTools } from "../../src/mod/fabric-only.ts";
import { register } from "../../src/mod/index.ts";

const named = (names: string[]) => names.map((name) => ({ name, description: "", mcp: false }));
const pool = [FABRIC_EXEC_TOOL, "Read", "Write", "Edit", "Grep", "Glob", "Bash", "WebSearch", "Agent", "WebFetch", "mcp__docs__guide"];

describe("withoutProgramTools", () => {
  test("hides the server-run program tools and keeps Read, WebSearch and every other tool", () => {
    expect([...HIDDEN_TOOLS].sort()).toEqual(["Bash", "Edit", "Glob", "Grep", "Write"]);
    expect(withoutProgramTools(named(pool)).map((tool) => tool.name)).toEqual([FABRIC_EXEC_TOOL, "Read", "WebSearch", "Agent", "WebFetch", "mcp__docs__guide"]);
  });

  test("hides nothing when fabric_exec is not in the list", () => {
    const plain = named(pool.slice(1));
    expect(withoutProgramTools(plain)).toEqual(plain);
  });

  test("the mode is on only for the boolean true", () => {
    expect(fabricOnly({ [FABRIC_ONLY_OPTION]: true })).toBe(true);
    expect(fabricOnly(undefined)).toBe(false);
    for (const value of [undefined, false, "true", 1]) expect(fabricOnly({ [FABRIC_ONLY_OPTION]: value })).toBe(false);
  });

  test("the manifest declares the option, off by default", async () => {
    const manifest = await Bun.file(new URL("../../.claude-plugin/plugin.json", import.meta.url)).json();
    expect(manifest.userConfig[FABRIC_ONLY_OPTION]).toMatchObject({ type: "boolean", default: false });
  });
});

type Handler = (dollar: unknown, event: unknown, next: (event: unknown) => unknown) => unknown;
const toolList = (options: Record<string, unknown>): Handler => {
  const handlers = new Map<string, Handler>();
  const on = (topic: string, ...rest: unknown[]) => {
    handlers.set(topic, rest.at(-1) as Handler);
    return { catch: () => undefined };
  };
  register(on as never, options as never);
  return handlers.get("tool.list")!;
};

describe("the tool.list hook", () => {
  test("hides the program tools with fabricOnly on", async () => {
    const result = await toolList({ [FABRIC_ONLY_OPTION]: true })({}, {}, () => ({ value: named(pool) })) as { value: { name: string }[] };
    expect(result.value.map((tool) => tool.name)).toEqual([FABRIC_EXEC_TOOL, "Read", "WebSearch", "Agent", "WebFetch", "mcp__docs__guide"]);
  });

  test("returns the list untouched with the option off or unset", async () => {
    const listed = { value: named(pool) };
    expect(await toolList({ [FABRIC_ONLY_OPTION]: false })({}, {}, () => listed)).toBe(listed);
    expect(await toolList({})({}, {}, () => listed)).toBe(listed);
  });
});
