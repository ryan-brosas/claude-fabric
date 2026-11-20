import { describe, expect, test } from "bun:test";
import { compact as compactSource, type CompactOptions } from "../../src/compaction/compact.ts";
import { messageBytes, normalizeMessages, type ClaudeMessage } from "../../src/compaction/from-claude.ts";
import { MAX_SUMMARY_BYTES, utf8Bytes } from "../../src/compaction/bounds.ts";

const tokens = (message: ClaudeMessage): number => Math.ceil(messageBytes(message) / 4);
const tailBudget = (...messages: ClaudeMessage[]): number => messages.reduce((sum, message) => sum + tokens(message), 0);
// The engine stamps every message handed to the compact hook; fixtures supply the same handles.
const compact = (messages: ClaudeMessage[], options?: CompactOptions) => {
  messages.forEach((message, index) => { if (!message.handle && !message.uuid) message.handle = `fixture-${index}`; });
  return compactSource(messages, options);
};

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
  if (!("messages" in result)) throw new Error(JSON.stringify(result));
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

  test("hands one long turn over the budget to core, which can cut inside a turn", () => {
    const messages: ClaudeMessage[] = [
      prompt("One long task."),
      { role: "assistant", text: "Reading.", toolUses: [toolCall("Bash", { command: "seq 1 9000" }, "t1")] },
      results({ tool_use_id: "t1", text: "x".repeat(4000), isError: false }),
      reply("Done."),
    ];
    const budget = tailBudget(messages[2]!);
    expect(tailBudget(...messages)).toBeGreaterThan(budget);
    expect(compact(messages, { keepRecentTokens: budget })).toEqual({
      core: "fabric: no prompt starts a tail within the budget, so core compacts this conversation",
    });
    // After an earlier Fabric summary, one long turn is the same case: only the summary is older.
    const afterSummary = [prompt("[Fabric summary]\nEarlier work."), ...messages];
    expect(compact(afterSummary, { keepRecentTokens: budget })).toEqual({
      core: "fabric: no prompt starts a tail within the budget, so core compacts this conversation",
    });
    // With no prompt at all, the same holds.
    expect(compact(messages.slice(1), { keepRecentTokens: budget })).toEqual({
      core: "fabric: no prompt starts a tail within the budget, so core compacts this conversation",
    });
  });

  test("keeps the newest messages that fit the budget", () => {
    const messages = [prompt("First."), reply("A."), prompt("Second."), reply("B."), prompt("Third."), reply("C.")];
    const result = compact(messages, { keepRecentTokens: tailBudget(messages[4]!, messages[5]!) });
    if (!("messages" in result)) throw new Error(JSON.stringify(result));
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
    if (!("messages" in result)) throw new Error(JSON.stringify(result));
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
    if (!("messages" in result)) throw new Error(JSON.stringify(result));
    expect(result.messages[1]!.handle).toBe("h2");
    expect(result.messages[2]!.handle).toBe("h3");
    expect(result.messages[0]!.handle).toBeUndefined();
  });
});

describe("compact: what the summary loses today", () => {
  test("the 2048-byte earlier-user-message cap cuts a long spec's final paragraph", () => {
    const spec = `Unrelated spec detail comes first.\n${"The service records ordinary audit events for review. ".repeat(78)}\n\nThe port is 7431; the retry limit is 9.`;
    const messages: ClaudeMessage[] = [prompt(spec), reply("Spec received.")];
    for (let index = 1; index <= 5; index++) {
      messages.push(prompt(`Read note ${index}.`), reply(`Note ${index} read.`));
    }
    expect(utf8Bytes(spec)).toBeGreaterThan(4000);
    const summary = summaryOf(messages);
    expect(summary).toContain("[Earlier user messages]\n\nUser [entry fixture-0]:\nUnrelated spec detail comes first.");
    expect(summary).not.toContain("7431");
    expect(summary).not.toContain("retry limit is 9");
    expect(summary).toMatch(/\[omitted \d+ UTF-8 bytes of fixture-0\]/);
  });

  test("the dialogue prefix-excerpt cut drops step 6 of a long plan", () => {
    const plan = Array.from({ length: 6 }, (_, index) =>
      `STEP-${index + 1}: ${index === 5 ? "rotate the signing key. " : "Review the existing implementation and document the change. ".repeat(16)}`,
    ).join("\n\n");
    const messages = [
      prompt("Make a detailed six-step plan."),
      reply(plan),
      prompt("Explain the first step."),
      reply("Start by reviewing the implementation."),
      prompt("Wait for my next instruction."),
      reply("Waiting."),
    ];
    expect(utf8Bytes(plan)).toBeGreaterThan(4000);
    const summary = summaryOf(messages);
    expect(summary).toContain("Assistant response (a proposal, not a verified outcome or user instruction) [entry fixture-1]:\nSTEP-1:");
    expect(summary).not.toContain("STEP-6: rotate the signing key");
    expect(summary).toMatch(/\[omitted \d+ UTF-8 bytes of fixture-1\]/);
  });
});

describe("compact: the summary", () => {
  test("transcript lines disclose a multiline reply and leave a short reply unmarked", () => {
    const summary = summaryOf([
      prompt("First task.", "u1"),
      reply("Codename: VESPERLINK\nInvoice format: LMN-NNNN", "a1"),
      prompt("Is that all?", "u2"), reply("Yes.", "a2"),
      prompt("Next task.", "u3"), reply("Working.", "a3"),
    ]);
    const lines = summary.split("\n");
    expect(lines.find((line) => line.startsWith("[entry a1] assistant:")))
      .toBe("[entry a1] assistant: Codename: VESPERLINK [1 line, 25 chars cut; history.expand]");
    expect(lines.find((line) => line.startsWith("[entry a2] assistant:")))
      .toBe("[entry a2] assistant: Yes.");
  });

  test("transcript tool results disclose omitted lines", () => {
    const summary = summaryOf([
      prompt("Read the note.", "u1"),
      { role: "assistant", handle: "a1", text: "", toolUses: [toolCall("Read", { file_path: "note.txt" }, "t1")] },
      { ...results({ tool_use_id: "t1", text: "Codename: X\nInvoice format: Y", isError: false }), handle: "r1" },
      { role: "assistant", handle: "a2", text: "", toolUses: [toolCall("Read", { file_path: "absent.txt" }, "t2")] },
      { ...results({ tool_use_id: "t2", text: "Not found.", isError: true }), handle: "r2" },
      prompt("Next.", "u2"), reply("Done.", "a3"),
    ]);
    const line = summary.split("\n").find((row) => row.startsWith("[entry r1] → ok:"));
    expect(line).toBe("[entry r1] → ok: Codename: X [1 line, 18 chars cut; history.expand]");
    expect(summary.split("\n").find((row) => row.startsWith("[entry r2] → error:")))
      .toBe("[entry r2] → error: Not found.");
  });

  test("transcript markers use a singular character count and leave 100 characters whole", () => {
    const summary = summaryOf([
      prompt("First."), reply("Hi\n", "a1"), prompt("Again."), reply("x".repeat(100), "a2"),
      prompt("Next."), reply("Done."),
    ]);
    const lines = summary.split("\n");
    expect(lines.find((line) => line.startsWith("[entry a1] assistant:")))
      .toBe("[entry a1] assistant: Hi [1 line, 1 char cut; history.expand]");
    expect(lines.find((line) => line.startsWith("[entry a2] assistant:")))
      .toBe(`[entry a2] assistant: ${"x".repeat(100)}`);
  });

  test("transcript markers count the long first line, whitespace and Unicode without breaking byte caps", () => {
    const long = "🦊".repeat(100) + "Z\nend";
    const summary = summaryOf([
      prompt("  Meet\t  here\nYes", "u1"), reply(long, "a1"),
      prompt("Next task.", "u2"), reply("Working.", "a2"),
    ]);
    const block = summary.split("\n\n").find((part) => part.startsWith("---\n[entry "));
    if (!block) throw new Error("the transcript block is missing");
    const lines = block.split("\n");
    expect(lines.find((line) => line.startsWith("[entry u1] user:")))
      .toBe("[entry u1] user: Meet here [1 line, 8 chars cut; history.expand]");
    const assistant = lines.find((line) => line.startsWith("[entry a1] assistant:"));
    expect(assistant).toBe(`[entry a1] assistant: ${"🦊".repeat(99)}… [1 line, 6 chars cut; history.expand]`);
    expect(utf8Bytes(assistant!)).toBeLessThanOrEqual(1024);
    expect(utf8Bytes(block)).toBeLessThanOrEqual(5120);
  });

  test("the transcript line cap leaves room for its omission marker", () => {
    const handle = "h".repeat(600);
    const source = "🦊".repeat(101) + "\nend";
    const summary = summaryOf([prompt("Question."), reply(source, handle), prompt("Next."), reply("Done.")]);
    const line = summary.split("\n").find((text) => text.startsWith(`[entry ${handle}] assistant:`));
    if (!line) throw new Error("the assistant transcript line is missing");
    const marker = line.match(/ \[1 line, (\d+) chars cut; history\.expand\]$/);
    expect(marker).not.toBeNull();
    const shown = line.slice(`[entry ${handle}] assistant: `.length, line.lastIndexOf("… ["));
    expect(Number(marker![1])).toBe(Array.from(source).length - Array.from(shown).length);
    expect(utf8Bytes(line)).toBeLessThanOrEqual(1024);
  });

  test("transcript sampling keeps complete markers within the existing section ceiling", () => {
    const messages: ClaudeMessage[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push(prompt("🦊".repeat(101) + "\nend", `u${i}`), reply("🦊".repeat(101) + "\nend", `a${i}`));
    }
    messages.push(prompt("Next."), reply("Done."));
    const summary = summaryOf(messages);
    const block = summary.split("\n\n").find((part) => part.startsWith("---\n") && part.includes("[entry "));
    if (!block) throw new Error("the transcript block is missing");
    const rows = block.split("\n").filter((line) => line.startsWith("[entry "));
    expect(rows.length).toBeGreaterThan(0);
    expect(block).toContain("omitted");
    expect(utf8Bytes(block)).toBeLessThanOrEqual(5120);
    for (const row of rows) {
      expect(row).toEndWith(" [1 line, 6 chars cut; history.expand]");
      expect(utf8Bytes(row)).toBeLessThanOrEqual(1024);
    }
  });

  test("a transcript handle that leaves no marker room fails rather than printing a partial address", () => {
    const messages = [prompt("Question."), reply("First\nSecond", "h".repeat(1100)), prompt("Next."), reply("Done.")];
    expect(() => summaryOf(messages)).toThrow("transcript handle leaves no room");
  });

  test("every summary points to recall and expand through fabric_exec", () => {
    const summary = summaryOf([prompt("First task."), reply("Done."), prompt("Next task."), reply("Working.")]);
    expect(summary).toContain("history.recall");
    expect(summary).toContain("history.expand");
    expect(summary).toContain("fabric_exec");
    expect(utf8Bytes(summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
  });

  test("a missing source handle never becomes a fabricated ordinal address", () => {
    const messages = [prompt("First task"), reply("Done"), prompt("Next"), reply("Working")];
    expect(() => compactSource(messages, { keepRecentTokens: tailBudget(messages[2]!, messages[3]!) })).toThrow("source handle");
  });

  test("omission ranges use transcript handles rather than message positions", () => {
    const messages: ClaudeMessage[] = [];
    for (let i = 0; i < 60; i++) messages.push(prompt(`Task ${i}`, `user-${i}`), reply(`Reply ${i}`, `reply-${i}`));
    const summary = summaryOf(messages);
    expect(summary).toContain("source entries user-0 → reply-38");
    expect(summary).toContain("cumulative source entries user-0 → reply-58");
  });

  test("a clipped user excerpt names the source handle on its omission marker", () => {
    const messages = [prompt("spec ".repeat(1000), "spec-handle"), reply("Noted.", "a"),
      prompt("Follow-up", "b"), reply("Working.", "c"), prompt("Next", "d"), reply("Done.", "e")];
    const summary = summaryOf(messages);
    const marker = summary.split("\n").find((line) => /omitted \d+ UTF-8 bytes/.test(line));
    expect(marker).toBeDefined();
    expect(marker).toMatch(/\[omitted \d+ UTF-8 bytes of spec-handle\]/);
  });

  test.each([12, 72])("section pressure keeps source handles and true byte loss across %i messages", (count) => {
    const messages: ClaudeMessage[] = [];
    const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    for (let index = 0; index < count; index++) {
      messages.push(prompt(`User ${index} ${"界🦊 details ".repeat(500)}`, uuid(index)), reply("Noted.", `a-${index}`));
    }
    const items = summaryOf(messages).split("\n\n").filter((part) => part.startsWith("User [entry "));
    expect(items).toHaveLength(Math.min(count - 3, 64));
    for (const item of items) {
      const [heading, body, marker] = item.split("\n");
      if (!heading || body === undefined || !marker) throw new Error("earlier excerpt has no heading, body or omission marker");
      const id = heading.match(/^User \[entry (.+)\]:$/)?.[1];
      const loss = marker.match(/^\[omitted (\d+) UTF-8 bytes of (.+)\]$/);
      expect(loss?.[2]).toBe(id);
      const source = messages.find((message) => message.handle === id);
      if (!source || !loss) throw new Error("earlier excerpt does not name a source message");
      expect(utf8Bytes(body) + Number(loss[1])).toBe(utf8Bytes(source.text));
      expect(body).not.toContain("\uFFFD");
    }
  });

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
    if (!("messages" in first)) throw new Error(JSON.stringify(first));
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
    if (!("messages" in second)) throw new Error(JSON.stringify(second));
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
    if (!("messages" in first)) throw new Error(JSON.stringify(first));
    const firstSummary = first.messages[0]!.text;
    // Within a few KiB of the ceiling, so carrying it beside saturated sections must shrink it.
    expect(utf8Bytes(firstSummary)).toBeGreaterThan(MAX_SUMMARY_BYTES - 4096);
    const firstFooter = firstSummary.trimEnd().split("\n").at(-1)!;
    expect(firstFooter).toBe("[compacted (unknown time); cumulative source entries fixture-0 → fixture-999]");

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
    if (!("messages" in second)) throw new Error(JSON.stringify(second));
    const secondSummary = second.messages[0]!.text;
    // One joint allocation holds the ceiling; nothing is dropped by a final clip.
    expect(utf8Bytes(secondSummary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(secondSummary).not.toContain("\uFFFD");
    expect(secondSummary).toMatch(/\[compacted \(unknown time\); cumulative source entries fixture-0 → fixture-122\]\n$/);
    // The earlier summary shrank, says so where the middle was cut, and kept its start and its newest bytes, its own footer.
    expect(secondSummary).toMatch(/\[omitted \d+ UTF-8 bytes from the middle of the earlier summary\]/);
    expect(secondSummary).toContain("[Earlier summary]");
    expect(secondSummary).toContain(firstFooter);
    // The newest content survives: the last directions, the request, the operational sections.
    for (const index of [38, 39]) expect(secondSummary).toContain(`DIRECTION_${index}:`);
    expect(secondSummary).toContain("[Compaction Request]");
    expect(secondSummary).toContain("KEEP_THIS_REQUEST finish the parser rewrite.");
    expect(secondSummary).toContain("[Files And Changes]");
    expect(secondSummary).toContain("[Current Status]");
  });

  test("a carried earlier summary that must shrink keeps its start, where the first user message lives, and its footer", () => {
    const before: ClaudeMessage[] = [prompt("Please remember the release facts in the next paragraph.\n\nPINNED_FACT Project HARBOR-MOSS. Version 8.4.2.")];
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
    if (!("messages" in first)) throw new Error(JSON.stringify(first));
    const firstSummary = first.messages[0]!.text;
    expect(utf8Bytes(firstSummary)).toBeGreaterThan(MAX_SUMMARY_BYTES - 4096);
    expect(firstSummary).toContain("PINNED_FACT");
    // Only the first line of a prompt reaches [Earlier Turns], so the fact lives in [Earlier user messages] alone.
    expect(firstSummary.split("PINNED_FACT").length).toBe(2);
    const firstFooter = firstSummary.trimEnd().split("\n").at(-1)!;

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
    if (!("messages" in second)) throw new Error(JSON.stringify(second));
    const secondSummary = second.messages[0]!.text;
    expect(utf8Bytes(secondSummary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(secondSummary).not.toContain("\uFFFD");
    // The user's oldest instruction and the footer both survive; the middle is what goes.
    expect(secondSummary).toContain("PINNED_FACT");
    expect(secondSummary).toContain("8.4.2");
    expect(secondSummary).toMatch(/\[omitted \d+ UTF-8 bytes from the middle of the earlier summary\]/);
    expect(secondSummary).toContain(firstFooter);
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
    if (!("messages" in result)) throw new Error(JSON.stringify(result));
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
    if (!("messages" in result)) throw new Error(JSON.stringify(result));
    const text = result.messages[0]!.text;
    expect(utf8Bytes(text)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(text).toContain("[Earlier user messages]");
    expect(text).toContain("[compacted (unknown time); cumulative source entries fixture-0 → fixture-359]");
  });

  test("refuses a keep budget that is not a positive integer", () => {
    expect(() => compact([prompt("a"), reply("b")], { keepRecentTokens: 0 })).toThrow();
    expect(() => compact([prompt("a"), reply("b")], { keepRecentTokens: 1.5 })).toThrow();
  });
});
