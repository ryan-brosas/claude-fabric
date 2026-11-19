// The prompt.compose hook, driven with a fake event and a fake next: the engine is a plain map of
// handlers here, so no Claude Code and no model are involved.
import { describe, expect, test } from "bun:test";
import { FABRIC_EXEC_TOOL, GUIDANCE_SECTION, GUIDANCE_TEXT } from "../../src/guidance/guidance.ts";
import { register } from "../../src/mod/index.ts";

type Handler = (dollar: unknown, event: unknown, next: (event: unknown) => unknown) => unknown;

interface Section { id: string; text: string; scope: "shared" | "session" }

// The hooks the mod registered, by topic, driven the way the engine drives them.
function hooks(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const on = (topic: string, handler: Handler) => {
    handlers.set(topic, handler);
    return { catch: () => undefined };
  };
  register(on as never, {} as never);
  return handlers;
}

const hook = (): Handler => {
  const found = hooks().get("prompt.compose");
  if (found === undefined) throw new Error("the mod registered no prompt.compose hook");
  return found;
};

const event = (tools: readonly string[]) => ({
  model: "a-model",
  promptModel: "a-model",
  surfaces: [],
  tools,
  outputStyle: null,
  traits: [],
});

const answer = (sections: readonly Section[]) => ({ sections });

const run = async (tools: readonly string[], sections: readonly Section[]) => {
  const next = (e: unknown) => answer(sections);
  return await hook()({}, event(tools), next) as { sections: readonly Section[] };
};

const base: readonly Section[] = [
  { id: "intro", text: "Intro.", scope: "shared" },
  { id: "doing_tasks", text: "Do the task.", scope: "shared" },
  { id: "tools", text: "Tools.", scope: "session" },
];

describe("the prompt.compose hook", () => {
  test("adds one session section last when the pool offers fabric_exec", async () => {
    const result = await run(["Read", FABRIC_EXEC_TOOL], base);
    expect(result.sections.length).toBe(base.length + 1);
    // Nothing the engine composed was rewritten, reordered or dropped.
    expect(result.sections.slice(0, base.length)).toEqual(base);
    expect(result.sections.at(-1)).toEqual({ id: GUIDANCE_SECTION, text: GUIDANCE_TEXT, scope: "session" });
  });

  test("adds nothing when the pool has no fabric_exec", async () => {
    expect(await run(["Read", "Bash"], base)).toEqual(answer(base));
  });

  test("adds the section once, not again on a recompose", async () => {
    const first = await run([FABRIC_EXEC_TOOL], base);
    const again = await run([FABRIC_EXEC_TOOL], first.sections);
    expect(again.sections).toEqual(first.sections);
    expect(again.sections.filter((section) => section.id === GUIDANCE_SECTION).length).toBe(1);
  });

  test("keeps the engine's answer untouched when a hook already added the section", async () => {
    const withSection: Section[] = [...base, { id: GUIDANCE_SECTION, text: "another text", scope: "session" }];
    expect(await run([FABRIC_EXEC_TOOL], withSection)).toEqual(answer(withSection));
  });
});
