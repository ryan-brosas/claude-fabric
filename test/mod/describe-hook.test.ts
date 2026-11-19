// The tool.describe hook, driven with a fake event and a fake next: fabric_exec is pinned into the
// prompt's tool list, and every other tool's answer goes back as the engine gave it.
import { describe, expect, test } from "bun:test";
import { FABRIC_EXEC_TOOL } from "../../src/guidance/guidance.ts";
import { register } from "../../src/mod/index.ts";

type Handler = (dollar: unknown, event: unknown, next: (event: unknown) => unknown) => unknown;

function hook(options: Record<string, unknown> = {}): Handler {
  const handlers = new Map<string, Handler>();
  const on = (topic: string, handler: Handler) => {
    handlers.set(topic, handler);
    return { catch: () => undefined };
  };
  register(on as never, options as never);
  const found = handlers.get("tool.describe");
  if (found === undefined) throw new Error("the mod registered no tool.describe hook");
  return found;
}

const deferred = { description: "Runs a program.", isDeferred: true };
const engine = { plugin: "engine", tier: "core" };
const listed = { description: "Schedules a job." };

describe("the tool.describe hook", () => {
  test("pins fabric_exec in front of ToolSearch and keeps its description", async () => {
    expect(await hook()({}, { tool: FABRIC_EXEC_TOOL, description: "Runs a program.", isDeferred: true }, () => deferred))
      .toEqual({ description: "Runs a program.", isDeferred: false });
  });

  test("leaves every other tool as the engine described it", async () => {
    for (const tool of ["mcp__context7__resolve-library-id", "Bash", "mcp__plugin_other_x__fabric_exec"]) {
      expect(await hook()({}, { tool, description: "Runs a program.", isDeferred: true, provider: engine }, () => deferred)).toBe(deferred);
    }
  });

  // Haiku benchmark, 2026-11-19: with code mode off an interactive session sent 22k tokens of
  // built-in schemas on every request, against 4.5k with native code mode.
  test("with fabricOnly on, an engine built-in goes behind ToolSearch", async () => {
    const on = hook({ fabricOnly: true });
    for (const tool of ["CronCreate", "Monitor", "NotebookEdit", "WebFetch", "Agent", "WebSearch"]) {
      expect(await on({}, { tool, description: "Schedules a job.", provider: engine }, () => listed)).toEqual({ ...listed, isDeferred: true });
    }
  });

  test("with fabricOnly on, Read, Skill, ToolSearch, the program tools and other plugins' tools stay where they are", async () => {
    const on = hook({ fabricOnly: true });
    for (const tool of ["Read", "Skill", "ToolSearch", "Bash", "Edit", "Write", "Grep", "Glob"]) {
      expect(await on({}, { tool, description: "Schedules a job.", provider: engine }, () => listed)).toBe(listed);
    }
    const plugin = { plugin: "easel", tier: "user" };
    expect(await on({}, { tool: "mcp__easel__chart", description: "Charts.", provider: plugin }, () => listed)).toBe(listed);
  });

  test("with fabricOnly off, no built-in moves", async () => {
    expect(await hook()({}, { tool: "CronCreate", description: "Schedules a job.", provider: engine }, () => listed)).toBe(listed);
  });
});
