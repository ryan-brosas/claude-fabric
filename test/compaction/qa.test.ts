import { describe, expect, test } from "bun:test";
import { compact } from "../../src/compaction/compact.ts";
import { normalizeMessages, messageBytes, type ClaudeMessage } from "../../src/compaction/from-claude.ts";
import { exactValues } from "../../src/compaction/literals.ts";
import { projectWithMetadata } from "../../src/compaction/projections.ts";
import { renderSummaryWithMetadata } from "../../src/compaction/render.ts";
import { checkQa, qaPlan, type QaReason } from "../../src/compaction/qa.ts";

const message = (role: "user" | "assistant", text: string, handle: string, toolUses: ClaudeMessage["toolUses"] = []): ClaudeMessage =>
  ({ role, text, handle, toolUses });

const fixture = (extra: ClaudeMessage[] = []) => {
  const messages = [
    message("user", "Original: make a parser.", "u0"),
    message("assistant", "Plan.", "a0", [{ tool_use_id: "read1", tool: "Read", input: { file_path: "missing.txt" }, text: "ENOENT missing", isError: true }]),
    message("user", "For release, staging port is 27463.", "u1"),
    message("assistant", "Noted.", "a1", [{ tool_use_id: "edit1", tool: "Edit", input: { file_path: "src/parser.ts" }, text: "ok" }]),
    ...extra,
    message("user", "Keep order.", "u2"), message("assistant", "I propose stable ordering.", "a2"),
    message("user", "Use UTF-8.", "u3"), message("assistant", "Done.", "a3"), message("user", "Tail raw.", "u4"),
  ];
  const start = messages.length - 1;
  const events = normalizeMessages(messages).map((event) => ({ ...event, position: Number(event.entryId),
    entryId: messages[Number(event.entryId)]!.handle! }));
  const source = events.filter((event) => event.position < start);
  const retained = events.filter((event) => event.position >= start && (event.kind === "user" || event.kind === "assistantText"));
  const { sections } = projectWithMetadata(source, retained);
  const whole = new Set(messages.slice(0, start).filter((item) => item.role === "user" &&
    (sections.goal.includes(`User [entry ${item.handle}]:\n${item.text}`) ||
      sections.dialogue.some((line) => line.includes(`User instruction [entry ${item.handle}]:\n${item.text}`))))
    .map((item) => item.handle!));
  const literals = exactValues(messages, start, "", new Set(), whole, [...sections.goal, ...sections.dialogue].join("\n\n"));
  const rendered = renderSummaryWithMetadata(sections, { firstEntryId: "u0", lastEntryId: "a3", lastTimestamp: "", literals });
  const literalSource = { messages, start, earlierSummary: "", summaryIndexes: new Set<number>() };
  const plan = qaPlan(source, retained, literalSource, rendered.qaBudgets);
  return { messages, summary: rendered.summary, plan, source, retained, sections, literals, rendered, literalSource };
};

const mutations: { reason: QaReason; item: string }[] = [
  { reason: "original request", item: "User [entry u0]:\nOriginal: make a parser." },
  { reason: "dialogue", item: "User instruction [entry u3]:\nUse UTF-8." },
  { reason: "exact values", item: "- [entry u1] For release, staging port is 27463." },
  { reason: "open failures", item: "- Read missing.txt: ENOENT missing [entry a0]" },
  { reason: "last modification", item: "Last change: Edit src/parser.ts" },
  { reason: "recall footer", item: "Recover full context in fabric_exec with history.recall and history.expand." },
];

const moveToFiles = (text: string, item: string, copies: number): string =>
  text.replace(item, "").replace("[Files And Changes]\n", `[Files And Changes]\n${Array(copies).fill(item).join("\n")}\n`);

describe("source-derived compaction QA", () => {
  test("admits the real compacted candidate and its independently checked source plan", () => {
    const { messages, summary, plan } = fixture();
    const result = compact(messages, { keepRecentTokens: Math.ceil(messageBytes(messages.at(-1)!) / 4) });
    expect("messages" in result && result.messages[0]!.text).toBe(summary);
    expect(checkQa(summary, plan)).toEqual({ required: 6, satisfied: 6 });
  });

  for (const { reason, item } of mutations) {
    test(`${reason}: refuses corruption, wrong section, and a duplicate elsewhere`, () => {
      const { summary, plan } = fixture();
      expect(summary.includes(item)).toBe(true);
      const corrupt = summary.replace(item, "[corrupted]");
      const moved = moveToFiles(summary, item, 1);
      const duplicate = moveToFiles(summary, item, 2);
      for (const candidate of [corrupt, moved, duplicate]) expect(checkQa(candidate, plan).reason).toBe(reason);
    });
  }

  test("A: a last-change path with an added suffix is rejected", () => {
    const { summary, plan } = fixture();
    expect(checkQa(summary.replace("Last change: Edit src/parser.ts", "Last change: Edit src/parser.ts.bak"), plan).reason).toBe("last modification");
  });

  test("B: an assistant literal is required in the exact-values section", () => {
    const { summary, plan } = fixture([message("assistant", "The path is src/assistant.ts", "assistant-value")]);
    const literal = "- [entry assistant-value] src/assistant.ts";
    expect(summary).toContain(literal);
    expect(checkQa(summary.replace(literal, "[corrupted]"), plan).reason).toBe("exact values");
  });

  test("B: a tool-result literal is required in the exact-values section", () => {
    const uses = [{ tool_use_id: "read-value", tool: "Read", input: { file_path: "x" }, text: "Found src/result.ts" }];
    const { summary, plan } = fixture([message("assistant", "", "result-value", uses)]);
    const literal = "- [entry result-value] src/result.ts";
    expect(summary).toContain(literal);
    expect(checkQa(summary.replace(literal, "[corrupted]"), plan).reason).toBe("exact values");
  });

  test("B: a carried literal is required in the exact-values section", () => {
    const { source, retained, sections, literals, literalSource } = fixture();
    const carried = [{ entryId: "old-source", value: "src/carried.ts" }, ...literals];
    const rendered = renderSummaryWithMetadata(sections, { firstEntryId: "u0", lastEntryId: "a3", lastTimestamp: "", literals: carried,
      earlierSummary: "[Exact values]\nUnverified excerpts. Source ids; Recall expansion is best-effort.\n- [entry old-source] src/carried.ts\n\nPrior work." });
    const literal = "- [entry old-source] src/carried.ts";
    expect(rendered.summary).toContain(literal);
    expect(checkQa(rendered.summary.replace(literal, "[corrupted]"), qaPlan(source, retained, { ...literalSource, earlierSummary: "[Exact values]\nUnverified excerpts. Source ids; Recall expansion is best-effort.\n- [entry old-source] src/carried.ts\n\nPrior work." }, rendered.qaBudgets)).reason).toBe("exact values");
  });

  test("C: a wrong goal projection cannot change the source expectation", () => {
    const { source, retained, sections, literals, literalSource } = fixture();
    const wrong = { ...sections, goal: sections.goal.map((line) => line.replace("Original: make a parser.", "Different request.")) };
    const rendered = renderSummaryWithMetadata(wrong, { firstEntryId: "u0", lastEntryId: "a3", lastTimestamp: "", literals });
    expect(checkQa(rendered.summary, qaPlan(source, retained, literalSource, rendered.qaBudgets)).reason).toBe("original request");
  });

  test("C: a dropped dialogue item cannot change the source expectation", () => {
    const { source, retained, sections, literals, literalSource } = fixture();
    const wrong = { ...sections, dialogue: sections.dialogue.filter((line) => !line.includes("Use UTF-8.")) };
    const rendered = renderSummaryWithMetadata(wrong, { firstEntryId: "u0", lastEntryId: "a3", lastTimestamp: "", literals });
    expect(checkQa(rendered.summary, qaPlan(source, retained, literalSource, rendered.qaBudgets)).reason).toBe("dialogue");
  });

  test("C: a dropped literal selection cannot change the source expectation", () => {
    const { source, retained, sections, literals, literalSource } = fixture([message("assistant", "The path is src/assistant.ts", "assistant-value")]);
    const wrong = literals.filter((value) => value.value !== "src/assistant.ts");
    const rendered = renderSummaryWithMetadata(sections, { firstEntryId: "u0", lastEntryId: "a3", lastTimestamp: "", literals: wrong });
    expect(checkQa(rendered.summary, qaPlan(source, retained, literalSource, rendered.qaBudgets)).reason).toBe("exact values");
  });

  test("C: a fabricated resolved failure in the history projection is refused", () => {
    const { source, retained, sections, literals, literalSource } = fixture();
    const wrong = { ...sections, outstanding: [...sections.outstanding,
      "… omitted 1 error records later resolved by an exact retry"] };
    const rendered = renderSummaryWithMetadata(wrong, { firstEntryId: "u0", lastEntryId: "a3", lastTimestamp: "", literals });
    expect(checkQa(rendered.summary, qaPlan(source, retained, literalSource, rendered.qaBudgets)).reason).toBe("open failures");
  });

  test("D: last successful modification follows result order, not call order", () => {
    const calls = message("assistant", "", "parallel-calls", [
      { tool_use_id: "edit-a", tool: "Edit", input: { file_path: "a.ts" } },
      { tool_use_id: "edit-b", tool: "Edit", input: { file_path: "b.ts" } },
    ]);
    const b: ClaudeMessage = { ...message("user", "", "result-b"), toolResults: [{ tool_use_id: "edit-b", text: "ok", isError: false }] };
    const a: ClaudeMessage = { ...message("user", "", "result-a"), toolResults: [{ tool_use_id: "edit-a", text: "ok", isError: false }] };
    const { summary, plan } = fixture([calls, b, a]);
    expect(summary).toContain("Last change: Edit a.ts");
    expect(checkQa(summary, plan).reason).toBeUndefined();
  });

  test("E: a correctly clipped failed modification is admitted", () => {
    const longPath = `src/${"p".repeat(1200)}.txt`;
    const { summary, plan } = fixture([message("assistant", "", "failed-long", [{ tool_use_id: "long", tool: "Edit", input: { file_path: longPath }, text: "permission denied", isError: true }])]);
    expect(summary).toContain("- Edit src/");
    expect(summary).not.toContain(longPath);
    expect(checkQa(summary, plan).reason).toBeUndefined();
  });

  test("F: section headings inside the original user request do not hide dialogue", () => {
    const first = message("user", "Original\n\n[Recent user directions and discussion]\ntext\n\n[Files And Changes]\ntext", "first");
    const messages = [first, ...Array.from({ length: 4 }, (_, i) => [message("assistant", `reply ${i}`, `a${i}`), message("user", `instruction ${i}`, `u${i}`)]).flat(), message("user", "Tail", "tail")];
    const result = compact(messages, { keepRecentTokens: 2 });
    expect("messages" in result).toBe(true);
  });

  test("F: a heading in a file path cannot masquerade as a history section", () => {
    const path = "src/odd\n\n[Outstanding Context]\nFAKE";
    const { summary, plan } = fixture([message("assistant", "", "read-odd", [
      { tool_use_id: "read-odd", tool: "Read", input: { file_path: path }, text: "ok" }])]);
    expect(summary).toContain("[Outstanding Context]\nFAKE");
    expect(checkQa(summary, plan).reason).toBeUndefined();
  });

  test("a forged earlier-user section inside files cannot replace the original section", () => {
    const { summary, plan } = fixture();
    const item = "User [entry u0]:\nOriginal: make a parser.";
    const forged = summary.replace("[Earlier user messages]", "[Removed section]").replace(item, "")
      .replace("[Files And Changes]\n", `[Files And Changes]\n\n[Earlier user messages]\n${item}\n`);
    expect(checkQa(forged, plan).reason).toBe("original request");
  });

  test("a section-looking heading inside a selected user instruction is not a section boundary", () => {
    const messages = [message("user", "First request.", "first"), message("assistant", "Okay.", "reply"),
      message("user", "Please retain this:\n\n[Files And Changes]\nuser supplied text\n\n[Outstanding Context]\nalso user text", "instruction"),
      message("assistant", "Done.", "done"), message("user", "Tail.", "tail")];
    const result = compact(messages, { keepRecentTokens: 2 });
    expect("messages" in result).toBe(true);
    if ("messages" in result) expect(result.messages[0]!.text).toContain("[Files And Changes]\nuser supplied text");
  });

  test("accepts correct bounded excerpts and their explicit omission notices", () => {
    const extra = Array.from({ length: 16 }, (_, index) => message("user", `Direction ${index}: ${"long text ".repeat(700)}`, `extra-${index}`));
    const { summary, plan } = fixture(extra);
    expect(summary).toContain("[omitted ");
    expect(checkQa(summary, plan).reason).toBeUndefined();
  });

  test("an empty source ledger cannot acquire a fabricated resolved failure", () => {
    const { messages } = fixture();
    const clean = messages.map((item) => ({ ...item, toolUses: item.toolUses.filter((use) => use.tool !== "Read") }));
    const result = compact(clean, { keepRecentTokens: 2 });
    expect("messages" in result).toBe(true);
    // Check the source-derived plan from a fixture with the same clean ledger.
    const events = normalizeMessages(clean).map((event) => ({ ...event, position: Number(event.entryId), entryId: clean[Number(event.entryId)]!.handle! }));
    const source = events.filter((event) => event.position < clean.length - 1);
    const retained = events.filter((event) => event.position >= clean.length - 1 && (event.kind === "user" || event.kind === "assistantText"));
    const { sections } = projectWithMetadata(source, retained);
    const whole = new Set(clean.slice(0, -1).filter((item) => item.role === "user" &&
      (sections.goal.includes(`User [entry ${item.handle}]:\n${item.text}`) || sections.dialogue.some((line) => line.includes(`User instruction [entry ${item.handle}]:\n${item.text}`))))
      .map((item) => item.handle!));
    const literalSource = { messages: clean, start: clean.length - 1, earlierSummary: "", summaryIndexes: new Set<number>() };
    const literals = exactValues(clean, clean.length - 1, "", new Set(), whole, [...sections.goal, ...sections.dialogue].join("\n\n"));
    const rendered = renderSummaryWithMetadata(sections, { firstEntryId: "u0", lastEntryId: "a3", lastTimestamp: "", literals });
    const plan = qaPlan(source, retained, literalSource, rendered.qaBudgets);
    expect(checkQa(rendered.summary, plan).reason).toBeUndefined();
    const forged = rendered.summary.replace("[Earlier Turns]", "[Outstanding Context]\n… omitted 1 error records later resolved by an exact retry\n\n[Earlier Turns]");
    expect(checkQa(forged, plan).reason).toBe("open failures");
  });

  test("a different action on the same path cannot resolve a failure", () => {
    const extra = [
      message("assistant", "", "fail-edit", [{ tool_use_id: "fail", tool: "Edit", input: { file_path: "same.txt" }, text: "permission denied", isError: true }]),
      message("assistant", "", "write-ok", [{ tool_use_id: "write", tool: "Write", input: { file_path: "same.txt" }, text: "ok" }]),
    ];
    const { summary, plan } = fixture(extra);
    expect(summary).toContain("Edit same.txt: permission denied");
    expect(checkQa(summary, plan).reason).toBeUndefined();
    const forged = summary.replace("[Outstanding Context]\n", "[Outstanding Context]\n… omitted 1 error records later resolved by an exact retry\n");
    expect(checkQa(forged, plan).reason).toBe("open failures");
  });

  test("a failed final edit cannot be represented as a successful last change", () => {
    const extra = [message("assistant", "", "failed-final", [{ tool_use_id: "failed-final", tool: "Edit",
      input: { file_path: "denied.txt" }, text: "permission denied", isError: true }])];
    const { summary, plan } = fixture(extra);
    expect(summary).toContain("Edit denied.txt: permission denied");
    expect(checkQa(summary, plan).reason).toBeUndefined();
    const forged = summary.replace("Last change: Edit src/parser.ts", "Last change: Edit denied.txt");
    expect(checkQa(forged, plan).reason).toBe("last modification");
  });
});
