import { describe, expect, test } from "bun:test";
import { register } from "../../src/mod/index.ts";

interface Event {
  trigger: "manual" | "auto" | "plugin" | "precompute";
  messages: unknown;
  instructions?: string;
}
type Next = (event: Event) => unknown;
type Handler = (dollar: unknown, event: Event, next: Next) => unknown;
interface Registration { catch(fallback: Handler): Registration }

// The engine's `on` and its `.catch`: what the mod registers, and the fallback
// the engine asks for when the hook throws. `run` calls the hook the way the
// engine does and falls back the same way.
const harness = () => {
  const calls: Event[] = [];
  const replies = [{ role: "user", text: "core summary", toolUses: [] }];
  const next: Next = (event) => {
    calls.push(event);
    return { messages: replies };
  };
  // The mod registers more than one hook, so each is kept by its own topic.
  const handlers = new Map<string, Handler>();
  let fallback: Handler | undefined;
  const registration: Registration = {
    catch(candidate) {
      fallback = candidate;
      return registration;
    },
  };
  const on = (topic: string, registered: Handler): Registration => {
    handlers.set(topic, registered);
    return registration;
  };
  register(on as never, {} as never);
  const run = (event: Event): unknown => {
    const handler = handlers.get("session.compact");
    if (!handler || !fallback) throw new Error("the mod registered no compaction hook with a catch");
    try {
      return handler({}, event, next);
    } catch (error) {
      return fallback({}, event, next);
    }
  };
  return { run, calls };
};

describe("the mod's session.compact hook", () => {
  test("precompute installs nothing and does not ask core", () => {
    const { run, calls } = harness();
    expect(run({ trigger: "precompute", messages: [{ role: "user", text: "Hello.", toolUses: [] }] }))
      .toEqual({ skip: "fabric: compaction is deterministic; nothing to precompute" });
    expect(calls).toEqual([]);
  });

  test.each(["manual", "auto"] as const)("%s reaches the deterministic compactor", (trigger) => {
    const { run, calls } = harness();
    expect(run({ trigger, messages: [{ role: "user", text: "Only task.", toolUses: [] }] }))
      .toEqual({ skip: "fabric: nothing to compact" });
    expect(calls).toEqual([]);
  });

  test("a compactor that throws falls back to core", () => {
    const { run, calls } = harness();
    const event: Event = { trigger: "manual", messages: undefined };
    expect(run(event)).toEqual({ messages: [{ role: "user", text: "core summary", toolUses: [] }] });
    expect(calls).toEqual([event]);
  });
});
