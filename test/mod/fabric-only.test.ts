// The fabricOnly option keeps the tools a program runs from the main conversation's model, only
// when fabric_exec is there to take their place. Agents keep every tool.
import { describe, expect, test } from "bun:test";
import { FABRIC_EXEC_TOOL } from "../../src/guidance/guidance.ts";
import { FABRIC_ONLY_OPTION, HIDDEN_TOOLS, fabricOnly, offered } from "../../src/mod/fabric-only.ts";
import { register } from "../../src/mod/index.ts";

const pool = [FABRIC_EXEC_TOOL, "Read", "Write", "Edit", "Grep", "Glob", "Bash", "WebSearch", "Agent", "WebFetch", "mcp__docs__guide"];
const shown = (facts: Parameters<typeof offered>[1]) => pool.filter((tool) => offered(tool, facts));

describe("offered", () => {
  test("the main conversation loses the server-run program tools and keeps Read, WebSearch and the rest", () => {
    expect([...HIDDEN_TOOLS].sort()).toEqual(["Bash", "Edit", "Glob", "Grep", "Write"]);
    expect(shown({ optionOn: true, fabricInPool: true })).toEqual([FABRIC_EXEC_TOOL, "Read", "WebSearch", "Agent", "WebFetch", "mcp__docs__guide"]);
  });

  test("an agent, a pool without fabric_exec, or the option off keeps every tool", () => {
    expect(shown({ optionOn: true, fabricInPool: true, agentId: "a1" })).toEqual(pool);
    expect(shown({ optionOn: true, fabricInPool: false })).toEqual(pool);
    expect(shown({ optionOn: false, fabricInPool: true })).toEqual(pool);
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
const hooks = (options: Record<string, unknown>) => {
  const handlers = new Map<string, Handler>();
  const on = (topic: string, ...rest: unknown[]) => {
    handlers.set(topic, rest.at(-1) as Handler);
    return { catch: () => undefined };
  };
  register(on as never, options as never);
  return handlers;
};
const listOf = (names: string[]) => ({ value: names.map((name) => ({ name, description: "", mcp: false })) });
const offer = async (h: Map<string, Handler>, tool: string, agentId?: string, engine = true) =>
  h.get("tool.offer")!({}, { tool, ...(agentId ? { agentId } : {}) }, () => ({ isOffered: engine }));

describe("the tool.offer hook", () => {
  test("with the option on, hides Bash from the main conversation once fabric_exec is in the pool", async () => {
    const h = hooks({ [FABRIC_ONLY_OPTION]: true });
    const listed = listOf(pool);
    expect(await h.get("tool.list")!({}, {}, () => listed)).toBe(listed);
    expect(await offer(h, "Bash")).toEqual({ isOffered: false });
    expect(await offer(h, "Read")).toEqual({ isOffered: true });
    expect(await offer(h, "Bash", "agent-1")).toEqual({ isOffered: true });
  });

  test("a call gets the answer the list showed, even after fabric_exec joins or leaves", async () => {
    const early = hooks({ [FABRIC_ONLY_OPTION]: true });
    // Asked before any tool list: fabric_exec has not joined, so Bash is offered for the loop's life.
    expect(await offer(early, "Bash")).toEqual({ isOffered: true });
    await early.get("tool.list")!({}, {}, () => listOf(pool));
    // The model calls Bash later: the call runs, as its list showed.
    expect(await offer(early, "Bash")).toEqual({ isOffered: true });
    // An agent's loop keeps Bash whenever it first asks.
    expect(await offer(early, "Bash", "agent-1")).toEqual({ isOffered: true });
    // A main loop that first asks with fabric_exec in the pool is not offered Edit, and its calls stay
    // refused even if fabric_exec leaves.
    const late = hooks({ [FABRIC_ONLY_OPTION]: true });
    await late.get("tool.list")!({}, {}, () => listOf(pool));
    expect(await offer(late, "Edit")).toEqual({ isOffered: false });
    await late.get("tool.list")!({}, {}, () => listOf(pool.slice(1)));
    expect(await offer(late, "Edit")).toEqual({ isOffered: false });
  });

  test("a session's end drops every answer, so the next conversation is asked afresh", async () => {
    const h = hooks({ [FABRIC_ONLY_OPTION]: true });
    expect(await offer(h, "Bash")).toEqual({ isOffered: true });
    await h.get("tool.list")!({}, {}, () => listOf(pool));
    expect(await offer(h, "Bash")).toEqual({ isOffered: true });
    await h.get("session.end")!({}, { reason: "clear" }, () => undefined);
    expect(await offer(h, "Bash")).toEqual({ isOffered: false });
  });

  test("never offers a tool the engine or another hook withheld, and leaves everything alone with the option off", async () => {
    const on = hooks({ [FABRIC_ONLY_OPTION]: true });
    await on.get("tool.list")!({}, {}, () => listOf(pool));
    expect(await offer(on, "Agent", undefined, false)).toEqual({ isOffered: false });
    const off = hooks({});
    await off.get("tool.list")!({}, {}, () => listOf(pool));
    expect(await offer(off, "Bash")).toEqual({ isOffered: true });
  });
});
