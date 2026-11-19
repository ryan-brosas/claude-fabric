import { describe, expect, test } from "bun:test";
import { compact } from "../../src/compaction/compact.ts";
import { messageBytes, normalizeMessages, type ClaudeMessage } from "../../src/compaction/from-claude.ts";
import { MAX_SUMMARY_BYTES, utf8Bytes } from "../../src/compaction/bounds.ts";

const tokens = (message: ClaudeMessage): number => Math.ceil(messageBytes(message) / 4);
const tailBudget = (...messages: ClaudeMessage[]): number => messages.reduce((sum, message) => sum + tokens(message), 0);

const prompt = (text: string, handle?: string): ClaudeMessage =>
  ({ role: "user", text, toolUses: [], ...(handle ? { handle } : {}) });
const reply = (text: string, handle?: string): ClaudeMessage =>
  ({ role: "assistant", text, toolUses: [], ...(handle ? { handle } : {}) });
const toolCall = (tool: string, input: Record<string, unknown>, id: string): ClaudeMessage["toolUses"][number] =>
  ({ tool_use_id: id, tool, input });
const results = (...items: NonNullable<ClaudeMessage["toolResults"]>): ClaudeMessage =>
  ({ role: "user", text: "", toolUses: [], toolResults: items });

const summaryOf = (messages: ClaudeMessage[]): string => {
  const result = compact(messages, { keepRecentTokens: tailBudget(messages.at(-2)!, messages.at(-1)!) });
  if (!("messages" in result)) throw new Error(result.skip);
  return result.messages[0]!.text;
};

describe("compact: the cut", () => {
  test("skips when nothing is older than the kept tail", () => {
    expect(compact([prompt("Only task."), reply("Done.")])).toEqual({ skip: "fabric: nothing to compact" });
  });

  test("skips a transcript with no user prompt to start a tail on", () => {
    expect(compact([reply("Working."), results({ tool_use_id: "t1", text: "ok", isError: false })])).toEqual({
      skip: "fabric: nothing to compact",
    });
  });

  test("keeps the newest messages that fit the budget", () => {
    const messages = [prompt("First."), reply("A."), prompt("Second."), reply("B."), prompt("Third."), reply("C.")];
    const result = compact(messages, { keepRecentTokens: tailBudget(messages[4]!, messages[5]!) });
    if (!("messages" in result)) throw new Error(result.skip);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[1]).toBe(messages[4]!);
    expect(result.messages[2]).toBe(messages[5]!);
  });

  test("never splits a tool_use from its result, where a naive newest-that-fits cut would", () => {
    const messages: ClaudeMessage[] = [
      prompt("First task."),
      { role: "assistant", text: "Reading the parser.", toolUses: [toolCall("Read", { file_path: "src/parser.ts" }, "t1")] },
      results({ tool_use_id: "t1", text: "x".repeat(1200), isError: false }),
      prompt("Second task."),
      reply("Done."),
    ];
    // The newest messages that fit start at the tool-result row; it is not a prompt.
    const budget = tailBudget(messages[2]!, messages[3]!, messages[4]!);
    expect(tailBudget(messages[1]!, messages[2]!, messages[3]!, messages[4]!)).toBeGreaterThan(budget);
    const result = compact(messages, { keepRecentTokens: budget });
    if (!("messages" in result)) throw new Error(result.skip);
    expect(result.messages[1]).toBe(messages[3]!);
    expect(result.messages[2]).toBe(messages[4]!);
    expect(result.messages).toHaveLength(3);
    // The call and its result are answered by the same id, so they land on the
    // same side of the cut and stay one paired exchange.
    const summarized = normalizeMessages(messages.slice(0, 3));
    expect(summarized.find((event) => event.kind === "toolCall"))
      .toMatchObject({ kind: "toolCall", toolCallId: "t1", name: "Read" });
    expect(summarized.find((event) => event.kind === "toolResult"))
      .toMatchObject({ kind: "toolResult", toolCallId: "t1", toolName: "Read", isError: false });
    const keptCalls = new Set(result.messages.flatMap((message) => message.toolUses.map((use) => use.tool_use_id)));
    for (const message of result.messages) {
      for (const kept of message.toolResults ?? []) expect(keptCalls.has(kept.tool_use_id)).toBe(true);
    }
  });

  test("kept messages keep their handle", () => {
    const messages = [prompt("First."), reply("A."), prompt("Second.", "h2"), reply("B.", "h3")];
    const result = compact(messages, { keepRecentTokens: tailBudget(messages[2]!, messages[3]!) });
    if (!("messages" in result)) throw new Error(result.skip);
    expect(result.messages[1]!.handle).toBe("h2");
    expect(result.messages[2]!.handle).toBe("h3");
    expect(result.messages[0]!.handle).toBeUndefined();
  });
});

describe("compact: the summary", () => {
  test("keeps an early user fact and an early failed Bash command", () => {
    const messages: ClaudeMessage[] = [
      prompt("Keep the public API stable."),
      { role: "assistant", text: "", toolUses: [{
        tool_use_id: "b1",
        tool: "Bash",
        input: { command: "bun test src/parser.test.ts" },
        text: "1 failing test in parser.test.ts",
        isError: true,
        result: { exitCode: 1 },
      }] },
      prompt("Continue."),
      reply("Working on it."),
      prompt("And now?"),
      reply("Almost done."),
    ];
    const summary = summaryOf(messages);
    expect(summary).toContain("Keep the public API stable.");
    expect(summary).toContain("Bash: bun test src/parser.test.ts");
    expect(summary).toContain("1 failing test in parser.test.ts");
  });

  test("a second compaction carries the first summary forward", () => {
    const messages: ClaudeMessage[] = [
      prompt(`Keep the public API stable. ${"context ".repeat(200)}`),
      { role: "assistant", text: "", toolUses: [{
        tool_use_id: "e1",
        tool: "Edit",
        input: { file_path: "src/parser.ts" },
        text: "updated 12 lines",
        result: { ok: true },
      }] },
      prompt(`Explain the parser boundary. ${"detail ".repeat(60)}`),
      reply("Explained."),
      prompt("Continue."),
      reply("Continuing."),
    ];
    const first = compact(messages, { keepRecentTokens: tailBudget(messages.at(-2)!, messages.at(-1)!) });
    if (!("messages" in first)) throw new Error(first.skip);
    const firstSummary = first.messages[0]!.text;
    // The fact sits past the 2,048-byte prose excerpt a plain user row keeps.
    expect(utf8Bytes(firstSummary)).toBeGreaterThan(2048);
    expect(firstSummary).toContain("Last change: Edit src/parser.ts");

    const later: ClaudeMessage[] = [
      ...first.messages,
      prompt("Second phase."),
      reply("Started."),
      prompt("Third phase."),
      reply("Working."),
    ];
    const second = compact(later, { keepRecentTokens: tailBudget(later.at(-2)!, later.at(-1)!) });
    if (!("messages" in second)) throw new Error(second.skip);
    const secondSummary = second.messages[0]!.text;
    expect(secondSummary).toContain("[Fabric summary]");
    expect(secondSummary).toContain("[Earlier summary]");
    expect(secondSummary).toContain("Keep the public API stable.");
    expect(secondSummary).toContain("Last change: Edit src/parser.ts");
    expect(secondSummary).toContain("[Current Status]");
    expect(secondSummary).toContain("Second phase.");
  });

  test("a near-ceiling earlier summary, carried beside saturated sections, keeps the newest directions, the request and the footer", () => {
    const before: ClaudeMessage[] = [];
    for (let index = 0; index < 200; index++) {
      before.push(prompt(`Request ${index}: ${"the parser boundary and its 界🦊 details ".repeat(60)}`));
      before.push({
        role: "assistant",
        text: `Reply ${index}: ${"long prose about the rewrite. ".repeat(120)}`,
        toolUses: [
          toolCall("Read", { file_path: `src/file-${index}.ts` }, `t${index}`),
          toolCall("Edit", { file_path: `src/edit-${index}.ts`, old_string: "a", new_string: "b" }, `e${index}`),
          toolCall("Write", { file_path: `src/write-${index}.ts`, content: "x" }, `w${index}`),
          toolCall("Grep", { pattern: `pattern-${index}` }, `g${index}`),
        ],
      });
      before.push(results(
        { tool_use_id: `t${index}`, text: "content. ".repeat(400), isError: false },
        { tool_use_id: `e${index}`, text: index % 3 === 0 ? `old_string not found in src/edit-${index}.ts after the rewrite` : "updated 12 lines", isError: index % 3 === 0 },
        { tool_use_id: `w${index}`, text: "wrote 12 lines", isError: false },
        { tool_use_id: `g${index}`, text: "match. ".repeat(120), isError: false },
      ));
      before.push({ role: "assistant", text: "", toolUses: [toolCall("Bash", { command: `bun test src/parser-${index}.test.ts --filter "a long filter name that keeps going"` }, `b${index}`)] });
      before.push(results({ tool_use_id: `b${index}`, text: `1 failing test in parser-${index}.test.ts: expected the rewrite to keep the public API stable`, isError: true }));
    }
    before.push(prompt("Latest request."), reply("Latest reply."));
    const first = compact(before, { keepRecentTokens: tailBudget(before.at(-2)!, before.at(-1)!) });
    if (!("messages" in first)) throw new Error(first.skip);
    const firstSummary = first.messages[0]!.text;
    // Within a few KiB of the ceiling, so carrying it beside saturated sections must shrink it.
    expect(utf8Bytes(firstSummary)).toBeGreaterThan(MAX_SUMMARY_BYTES - 4096);
    const firstFooter = firstSummary.trimEnd().split("\n").at(-1)!;
    expect(firstFooter).toContain("[compacted (unknown time); cumulative source entries 0 → ");

    const after: ClaudeMessage[] = [...first.messages];
    for (let index = 0; index < 40; index++) {
      after.push(prompt(`DIRECTION_${index}: ${"fresh 界🦊 detail ".repeat(200)}`));
      after.push({
        role: "assistant",
        text: `Fresh reply ${index}: ${"more prose. ".repeat(80)}`,
        toolUses: [toolCall("Edit", { file_path: `src/fresh-${index}.ts`, old_string: "a", new_string: "b" }, `f${index}`)],
      });
      after.push(results({ tool_use_id: `f${index}`, text: "updated 3 lines", isError: false }));
    }
    after.push(prompt("DIRECTION_FINAL: finish the parser rewrite."), reply("On it."));
    const second = compact(after, {
      keepRecentTokens: tailBudget(after.at(-2)!, after.at(-1)!),
      instructions: "KEEP_THIS_REQUEST finish the parser rewrite.",
    });
    if (!("messages" in second)) throw new Error(second.skip);
    const secondSummary = second.messages[0]!.text;
    // One joint allocation holds the ceiling; nothing is dropped by a final clip.
    expect(utf8Bytes(secondSummary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(secondSummary).not.toContain("\uFFFD");
    expect(secondSummary).toMatch(/\[compacted \(unknown time\); cumulative source entries 0 → \d+\]\n$/);
    // The earlier summary shrank, says so, and kept its newest bytes: its own footer.
    expect(secondSummary).toMatch(/\[omitted \d+ UTF-8 bytes from the start of the earlier summary\]/);
    expect(secondSummary).toContain("[Earlier summary]");
    expect(secondSummary).toContain(firstFooter);
    // The newest content survives: the last directions, the request, the operational sections.
    for (const index of [38, 39]) expect(secondSummary).toContain(`DIRECTION_${index}:`);
    expect(secondSummary).toContain("[Compaction Request]");
    expect(secondSummary).toContain("KEEP_THIS_REQUEST finish the parser rewrite.");
    expect(secondSummary).toContain("[Files And Changes]");
    expect(secondSummary).toContain("[Current Status]");
  });

  test("a failed change is an attempt, never the last change", () => {
    const messages: ClaudeMessage[] = [
      prompt("Patch the parser."),
      { role: "assistant", text: "", toolUses: [toolCall("Edit", { file_path: "src/parser.ts" }, "e1")] },
      results({ tool_use_id: "e1", text: "updated 12 lines", isError: false }),
      { role: "assistant", text: "", toolUses: [toolCall("Edit", { file_path: "src/broken.ts" }, "e2")] },
      results({ tool_use_id: "e2", text: "old_string not found", isError: true }),
      prompt("Continue."),
      reply("Done."),
    ];
    const summary = summaryOf(messages);
    expect(summary).toContain("Last change: Edit src/parser.ts");
    expect(summary).not.toContain("Last change: Edit src/broken.ts");
    // The failure itself still reaches [Outstanding Context].
    expect(summary).toContain("Edit src/broken.ts: old_string not found");
  });

  test("renders the instructions as the compaction request", () => {
    const messages = [prompt("First."), reply("A."), prompt("Second."), reply("B.")];
    const result = compact(messages, {
      keepRecentTokens: tailBudget(messages[2]!, messages[3]!),
      instructions: "Focus on the parser rewrite.",
    });
    if (!("messages" in result)) throw new Error(result.skip);
    expect(result.messages[0]!.text).toContain("[Compaction Request]");
    expect(result.messages[0]!.text).toContain("Focus on the parser rewrite.");
  });

  test("stays within the summary byte ceiling on a large transcript", () => {
    const messages: ClaudeMessage[] = [];
    for (let index = 0; index < 120; index++) {
      messages.push(prompt(`Request ${index}: ${"界🦊 details. ".repeat(180)}`));
      messages.push({
        role: "assistant",
        text: `Reply ${index}: ${"long prose. ".repeat(300)}`,
        toolUses: [toolCall("Read", { file_path: `src/file-${index}.ts` }, `t${index}`)],
      });
      messages.push(results({ tool_use_id: `t${index}`, text: "content. ".repeat(400), isError: false }));
    }
    messages.push(prompt("Latest request."), reply("Latest reply."));
    const result = compact(messages, { keepRecentTokens: tailBudget(messages.at(-2)!, messages.at(-1)!) });
    if (!("messages" in result)) throw new Error(result.skip);
    const text = result.messages[0]!.text;
    expect(utf8Bytes(text)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(text).toContain("[Earlier user messages]");
    expect(text).toContain("[compacted (unknown time); cumulative source entries 0 → ");
  });

  test("refuses a keep budget that is not a positive integer", () => {
    expect(() => compact([prompt("a"), reply("b")], { keepRecentTokens: 0 })).toThrow();
    expect(() => compact([prompt("a"), reply("b")], { keepRecentTokens: 1.5 })).toThrow();
  });
});
