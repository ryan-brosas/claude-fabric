// The tool.describe hook, driven with a fake event and a fake next: fabric_exec is pinned into the
// prompt's tool list, and every other tool's answer goes back as the engine gave it.
import { describe, expect, test } from "bun:test";
import { FABRIC_EXEC_TOOL } from "../../src/guidance/guidance.ts";
import { register } from "../../src/mod/index.ts";

type Handler = (dollar: unknown, event: unknown, next: (event: unknown) => unknown) => unknown;

function hook(): Handler {
  const handlers = new Map<string, Handler>();
  const on = (topic: string, handler: Handler) => {
    handlers.set(topic, handler);
    return { catch: () => undefined };
  };
  register(on as never, {} as never);
  const found = handlers.get("tool.describe");
  if (found === undefined) throw new Error("the mod registered no tool.describe hook");
  return found;
}

const deferred = { description: "Runs a program.", isDeferred: true };

describe("the tool.describe hook", () => {
  test("pins fabric_exec in front of ToolSearch and keeps its description", async () => {
    expect(await hook()({}, { tool: FABRIC_EXEC_TOOL, description: "Runs a program.", isDeferred: true }, () => deferred))
      .toEqual({ description: "Runs a program.", isDeferred: false });
  });

  test("leaves every other tool as the engine described it", async () => {
    for (const tool of ["mcp__context7__resolve-library-id", "Bash", "mcp__plugin_other_x__fabric_exec"]) {
      expect(await hook()({}, { tool, description: "Runs a program.", isDeferred: true }, () => deferred)).toBe(deferred);
    }
  });
});
