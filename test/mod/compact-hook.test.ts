import { describe, expect, test } from "bun:test";
import { register } from "../../src/mod/index.ts";
import { userSelection } from "../../src/compaction/verified/generated/policy.js";

interface Event {
  trigger: "manual" | "auto" | "plugin" | "precompute";
  messages: unknown;
  instructions?: string;
}
type Next = (event: Event) => unknown;
type Handler = (dollar: unknown, event: Event, next: Next) => unknown;
type Failure = { kind: "throw" | "timeout"; message?: string; budget: number };
type Fallback = (dollar: unknown, event: Event, next: Next & { error: Failure; called: boolean }) => unknown;
interface Registration { catch(fallback: Fallback): Registration }

// The engine's `on` and its `.catch`: what the mod registers, and the fallback
// the engine asks for when the hook throws. `run` calls the hook the way the
// engine does and falls back the same way.
const harness = (options: { logThrows?: boolean } = {}) => {
  const calls: Event[] = [];
  const logs: { line: string; to?: string }[] = [];
  const operations: string[] = [];
  const failures: Failure[] = [];
  const dollar = { ui: { log: (line: string, target?: { to?: string }) => {
    operations.push("log");
    logs.push({ line, to: target?.to });
    if (options.logThrows) throw new Error("debug log unavailable");
  } } };
  const replies = [{ role: "user", text: "core summary", toolUses: [] }];
  const next: Next = (event) => {
    operations.push("next");
    calls.push(event);
    return { messages: replies };
  };
  // Each registration owns its catch; later hooks must not overwrite this one.
  const handlers = new Map<string, Handler>();
  const fallbacks = new Map<string, Fallback>();
  const on = (topic: string, registered: Handler): Registration => {
    handlers.set(topic, registered);
    const registration: Registration = {
      catch(candidate) {
        fallbacks.set(topic, candidate);
        return registration;
      },
    };
    return registration;
  };
  register(on as never, {} as never);
  const fail = (event: Event, failure: Failure): unknown => {
    const fallback = fallbacks.get("session.compact");
    if (!fallback) throw new Error("the mod registered no compaction catch");
    failures.push(failure);
    const caught = Object.assign((e: Event) => next(e), { error: failure, called: false });
    return fallback(dollar, event, caught);
  };
  const run = (event: Event): unknown => {
    const handler = handlers.get("session.compact");
    if (!handler) throw new Error("the mod registered no compaction hook");
    try {
      return handler(dollar, event, next);
    } catch (error) {
      return fail(event, { kind: "throw", message: error instanceof Error ? error.message : String(error), budget: 1000 });
    }
  };
  return { run, fail, calls, logs, operations, failures };
};

describe("the mod's session.compact hook", () => {
  test("a missing required omission notice follows the existing hook fallback", () => {
    const { run, calls, logs } = harness();
    const messages = Array.from({ length: 70 }, (_, i) => ({ role: "user", text: `User ${i}`, toolUses: [], handle: `u-${i}` }));
    messages.push({ role: "user", text: "x".repeat(79_990), toolUses: [], handle: "tail" });
    const event: Event = { trigger: "manual", messages };
    const original = userSelection.step;
    try {
      userSelection.step = (params, state, input) => {
        const row = input as { op: number; notice: number };
        return original(params, state, row.op === 2 ? { ...row, notice: 0 } : input);
      };
      expect(run(event)).toEqual({ messages: [{ role: "user", text: "core summary", toolUses: [] }] });
      expect(calls).toEqual([event]);
      expect(logs[0]?.line).toContain("earlier-user omission notice did not survive rendering");
    } finally {
      userSelection.step = original;
    }
  });

  test("precompute installs nothing and does not ask core", () => {
    const { run, calls } = harness();
    expect(run({ trigger: "precompute", messages: [{ role: "user", text: "Hello.", toolUses: [] }] }))
      .toEqual({ skip: "fabric: compaction is deterministic; nothing to precompute" });
    expect(calls).toEqual([]);
  });

  test.each(["manual", "auto"] as const)("%s reaches the deterministic compactor", (trigger) => {
    const { run, calls } = harness();
    const event: Event = { trigger, messages: [{ role: "user", text: "Only task.", toolUses: [] }] };
    const result = run(event);
    if (trigger === "manual") {
      expect(result).toEqual({ skip: "fabric: nothing to compact" });
      expect(calls).toEqual([]);
    } else {
      expect(result).toEqual({ messages: [{ role: "user", text: "core summary", toolUses: [] }] });
      expect(calls).toEqual([event]);
    }
  });

  test("automatic compaction delegates a skip from media-only message projections to core", () => {
    const { run, calls } = harness();
    // The hook receives text projections and opaque handles, not the original image blocks.
    // An auto trigger is the engine's signal that the real conversation needs compaction.
    const event: Event = {
      trigger: "auto",
      messages: [
        { role: "user", text: "", toolUses: [], handle: "image-1" },
        { role: "user", text: "", toolUses: [], handle: "image-2" },
      ],
    };
    expect(run(event)).toEqual({ messages: [{ role: "user", text: "core summary", toolUses: [] }] });
    expect(calls).toEqual([event]);
    expect(calls[0]).toBe(event);
  });

  test("an automatic skip after a Fabric summary delegates without attempting a rebuild", () => {
    const { run, calls, logs } = harness();
    const event: Event = { trigger: "auto", messages: [
      { role: "user", text: "[Fabric summary]\nEarlier work.", toolUses: [], handle: "summary" },
      { role: "user", text: "", toolUses: [], handle: "image" },
    ] };
    expect(run(event)).toEqual({ messages: [{ role: "user", text: "core summary", toolUses: [] }] });
    expect(calls).toEqual([event]);
    expect(logs).toEqual([]);
  });

  test("a plugin-triggered skip remains a skip", () => {
    const { run, calls } = harness();
    expect(run({ trigger: "plugin", messages: [{ role: "user", text: "Only task.", toolUses: [] }] }))
      .toEqual({ skip: "fabric: nothing to compact" });
    expect(calls).toEqual([]);
  });

  test.each(["manual", "auto"] as const)("%s keeps a valid Fabric summary", (trigger) => {
    const { run, calls } = harness();
    const tail = { role: "user", text: "x".repeat(79_990), toolUses: [], handle: "tail" };
    const event: Event = { trigger, messages: [
      { role: "user", text: "An older task.", toolUses: [], handle: "old-user" },
      { role: "assistant", text: "An older answer.", toolUses: [], handle: "old-answer" },
      tail,
    ] };
    const result = run(event) as { messages: { text: string; handle?: string }[] };
    expect(result.messages[0]?.text).toStartWith("[Fabric summary]");
    expect(result.messages[1]).toBe(tail);
    expect(calls).toEqual([]);
  });

  test("one long turn over the budget goes to core instead of being vetoed", () => {
    const { run, calls } = harness();
    const event: Event = {
      trigger: "auto",
      messages: [
        { role: "user", text: "One long task.", toolUses: [] },
        { role: "assistant", text: "x".repeat(200_000), toolUses: [] },
      ],
    };
    expect(run(event)).toEqual({ messages: [{ role: "user", text: "core summary", toolUses: [] }] });
    expect(calls).toEqual([event]);
  });

  test("a compactor error logs its reason to debug before delegating", () => {
    const { run, calls, logs, operations, failures } = harness();
    const event: Event = {
      trigger: "manual",
      messages: [
        { role: "user", text: "Question.", toolUses: [], handle: "first" },
        { role: "assistant", text: "First\nSecond", toolUses: [], handle: "h".repeat(1100) },
        { role: "user", text: "x".repeat(79_990), toolUses: [], handle: "next" },
      ],
    };
    expect(run(event)).toEqual({ messages: [{ role: "user", text: "core summary", toolUses: [] }] });
    expect(calls).toEqual([event]);
    expect(failures[0]?.kind).toBe("throw");
    expect(failures[0]?.message).toContain("transcript handle leaves no room");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.to).toBe("debug");
    expect(logs[0]?.line).toContain("throw");
    expect(logs[0]?.line).toContain("transcript handle leaves no room");
    expect(operations).toEqual(["log", "next"]);
  });

  test.each([undefined, "downstream rejected"])("a timeout logs its reason (%s) and delegates", (message) => {
    const { fail, calls, logs, operations } = harness();
    const event: Event = { trigger: "auto", messages: [] };
    expect(fail(event, { kind: "timeout", message, budget: 1000 }))
      .toEqual({ messages: [{ role: "user", text: "core summary", toolUses: [] }] });
    expect(calls).toEqual([event]);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.to).toBe("debug");
    expect(logs[0]?.line).toContain("timeout");
    expect(logs[0]?.line).toContain(message ?? "no error message");
    expect(operations).toEqual(["log", "next"]);
  });

  test("a failed debug log cannot block fallback to core", () => {
    const { run, calls, logs, operations } = harness({ logThrows: true });
    const event: Event = { trigger: "manual", messages: undefined };
    expect(run(event)).toEqual({ messages: [{ role: "user", text: "core summary", toolUses: [] }] });
    expect(calls).toEqual([event]);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.to).toBe("debug");
    expect(operations).toEqual(["log", "next"]);
  });

  test("a compactor that throws falls back to core", () => {
    const { run, calls } = harness();
    const event: Event = { trigger: "manual", messages: undefined };
    expect(run(event)).toEqual({ messages: [{ role: "user", text: "core summary", toolUses: [] }] });
    expect(calls).toEqual([event]);
  });
});
