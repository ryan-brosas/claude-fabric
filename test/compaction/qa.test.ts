import { describe, expect, test } from "bun:test";
import { compact } from "../../src/compaction/compact.ts";
import { normalizeMessages, messageBytes, type ClaudeMessage } from "../../src/compaction/from-claude.ts";
import { exactValues, renderExactValues } from "../../src/compaction/literals.ts";
import { projectWithMetadata } from "../../src/compaction/projections.ts";
import { renderSummaryWithMetadata } from "../../src/compaction/render.ts";
import { checkQa, qaPlan, type QaReason } from "../../src/compaction/qa.ts";
import { sourceFailures } from "../../src/compaction/qa-history.ts";
import { clipUtf8, MAX_RENDERED_LINE_BYTES, utf8Bytes } from "../../src/compaction/bounds.ts";

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

const replaceInSection = (candidate: { summary: string; plan: ReturnType<typeof qaPlan> }, name: string, old: string, replacement: string) => {
  const span = candidate.plan.spans.find((item) => item.name === name);
  if (!span) throw new Error(`missing span ${name}`);
  const at = candidate.summary.indexOf(old, span.start);
  if (at < span.start || at + old.length > span.end) throw new Error(`missing content in ${name}`);
  const delta = replacement.length - old.length;
  const spans = candidate.plan.spans.map((item) => item === span ? { ...item, end: item.end + delta }
    : item.start > span.start ? { ...item, start: item.start + delta, end: item.end + delta } : item);
  return { summary: candidate.summary.slice(0, at) + replacement + candidate.summary.slice(at + old.length), plan: { ...candidate.plan, spans } };
};

describe("source-derived compaction QA", () => {
  test("admits the real compacted candidate and its independently checked source plan", () => {
    const { messages, summary, plan } = fixture();
    const result = compact(messages, { keepRecentTokens: Math.ceil(messageBytes(messages.at(-1)!) / 4) });
    expect("messages" in result && result.messages[0]!.text).toBe(summary);
    expect(checkQa(summary, plan)).toEqual({ required: 9, satisfied: 9 });
  });

  for (const { reason, item } of mutations) {
    test(`${reason}: refuses corruption, wrong section, and a duplicate elsewhere`, () => {
      const { summary, plan } = fixture();
      expect(summary.includes(item)).toBe(true);
      const section = reason === "original request" ? "[Earlier user messages]" : reason === "dialogue" ? "[Recent user directions and discussion]"
        : reason === "exact values" ? "[Exact values]" : reason === "open failures" ? "[Outstanding Context]"
        : reason === "last modification" ? "[Current Status]" : "footer";
      const original = { summary, plan };
      const corrupt = replaceInSection(original, section, item, "[corrupted]");
      const removed = replaceInSection(original, section, item, "");
      const moved = replaceInSection(removed, "[Files And Changes]", "[Files And Changes]\n", `[Files And Changes]\n${item}\n`);
      const duplicate = replaceInSection(removed, "[Files And Changes]", "[Files And Changes]\n", `[Files And Changes]\n${item}\n${item}\n`);
      for (const candidate of [corrupt, moved, duplicate]) expect(checkQa(candidate.summary, candidate.plan).reason).toBe(reason);
    });
  }

  test("A: a suffix, wrong path or duplicate last change is rejected with valid spans", () => {
    const { summary, plan } = fixture();
    const line = "Last change: Edit src/parser.ts";
    for (const replacement of [`${line}.bak`, "Last change: Edit src/other.ts", `${line}\n${line}`]) {
      const candidate = replaceInSection({ summary, plan }, "[Current Status]", line, replacement);
      expect(checkQa(candidate.summary, candidate.plan).reason).toBe("last modification");
    }
  });

  test("R3-6: shifted or source-text spans cannot authorize a forged change", () => {
    const { summary, plan } = fixture([message("user", "Quoted:\n\n[Current Status]\nLast change: Edit src/parser.ts", "quote")]);
    const status = plan.spans.find((span) => span.name === "[Current Status]")!;
    const poisoned = summary.slice(0, status.start) + summary.slice(status.start).replace("Last change: Edit src/parser.ts", "Last change: Edit invented.ts");
    const shifted = { ...plan, spans: plan.spans.map((span) => span.name === "[Current Status]" ? { ...span, start: span.start + 1 } : span) };
    expect(checkQa(poisoned, shifted).reason).toBeDefined();
    const fake = summary.indexOf("[Current Status]\nLast change: Edit src/parser.ts");
    expect(fake).toBeGreaterThan(0);
    const pointed = { ...plan, spans: plan.spans.map((span) => span.name === "[Current Status]" ? { ...span, start: fake, end: fake + 54 } : span) };
    expect(checkQa(poisoned, pointed).reason).toBeDefined();
  });

  test("R3-6: a harmless files-section format change does not relocate QA content", () => {
    const { source, retained, sections, literals, literalSource } = fixture();
    const changed = { ...sections, files: ["Formatting only", ...sections.files] };
    const rendered = renderSummaryWithMetadata(changed, { firstEntryId: "u0", lastEntryId: "a3", lastTimestamp: "", literals });
    expect(rendered.summary).toContain("[Files And Changes]\nFormatting only");
    expect(checkQa(rendered.summary, qaPlan(source, retained, literalSource, rendered.qaBudgets)).reason).toBeUndefined();
  });

  test("R3-2: a dropped sole literal cannot eliminate its own allocation", () => {
    const messages = [message("user", "Build.", "u"), message("assistant", `${"x".repeat(5000)} src/only.ts ${"y".repeat(5000)}`, "a"),
      message("user", "Tail.", "tail")];
    const start = messages.length - 1;
    const events = normalizeMessages(messages).map((event) => ({ ...event, position: Number(event.entryId), entryId: messages[Number(event.entryId)]!.handle! }));
    const source = events.filter((event) => event.position < start);
    const retained = events.filter((event) => event.position >= start && (event.kind === "user" || event.kind === "assistantText"));
    const { sections } = projectWithMetadata(source, retained);
    const literalSource = { messages, start, earlierSummary: "", summaryIndexes: new Set<number>() };
    const healthy = renderSummaryWithMetadata(sections, { firstEntryId: "u", lastEntryId: "a2", lastTimestamp: "", literals: [{ entryId: "a", value: "src/only.ts" }] });
    expect(healthy.summary).toContain("- [entry a] src/only.ts");
    const dropped = renderSummaryWithMetadata(sections, { firstEntryId: "u", lastEntryId: "a2", lastTimestamp: "", literals: [] });
    expect(dropped.qaBudgets.literals).toBe(0);
    expect(checkQa(dropped.summary, qaPlan(source, retained, literalSource, dropped.qaBudgets)).reason).toBe("exact values");
  });

  for (const tool of ["Edit", "Write"] as const) for (const path of ["src/a\nb.ts", "src/a\n\n[Outstanding Context]\nb.ts"]) {
    test(`R3-3: ${tool} accepts a complete multiline path ${JSON.stringify(path)}`, () => {
      const { summary, plan } = fixture([message("assistant", "", "multiline", [{ tool_use_id: "multiline", tool, input: { file_path: path }, text: "ok" }])]);
      expect(summary).toContain(`Last change: ${tool} ${path}`);
      expect(checkQa(summary, plan).reason).toBeUndefined();
    });
  }

  test("R3-pressure: the literal grant silently drops records that fit its section ceiling", () => {
    const paths = Array.from({ length: 50 }, (_, index) => `src/file${String(index).padStart(3, "0")}.ts`);
    const messages = [message("user", "Original request.", "first"),
      message("assistant", `${"x".repeat(5000)} ${paths.join(" ")} ${"y".repeat(5000)}`, "many"),
      ...Array.from({ length: 24 }, (_, index) => [message("user", "u".repeat(5000), `u${index}`),
        message("assistant", "a".repeat(5000), `a${index}`)]).flat(), message("user", "Tail", "tail")];
    const start = messages.length - 1;
    const events = normalizeMessages(messages).map((event) => ({ ...event, position: Number(event.entryId), entryId: messages[Number(event.entryId)]!.handle! }));
    const source = events.filter((event) => event.position < start);
    const retained = events.filter((event) => event.position >= start && (event.kind === "user" || event.kind === "assistantText"));
    const { sections } = projectWithMetadata(source, retained);
    const literals = exactValues(messages, start, "", new Set());
    const rendered = renderSummaryWithMetadata(sections, { firstEntryId: "first", lastEntryId: "a23", lastTimestamp: "", literals });
    const block = rendered.summary.split("[Exact values]\n")[1]?.split("\n\n")[0] ?? "";
    const shown = block.split("\n").filter((line) => line.startsWith("- [entry many] "));
    const withCeiling = renderExactValues(literals, 2048);
    expect(withCeiling.split("\n").filter((line) => line.startsWith("- [entry many] "))).toHaveLength(50);
    expect(literals).toHaveLength(50);
    expect(rendered.qaBudgets.literals).toBe(1432);
    expect(shown).toHaveLength(45);
    expect(block).not.toMatch(/omitted/i);
    const literalSource = { messages, start, earlierSummary: "", summaryIndexes: new Set<number>() };
    expect(checkQa(rendered.summary, qaPlan(source, retained, literalSource, rendered.qaBudgets)).reason).toBeUndefined();
    const result = compact(messages, { keepRecentTokens: Math.ceil(messageBytes(messages.at(-1)!) / 4) });
    const candidate = "qa" in result ? result.candidate : "messages" in result ? result.messages : [];
    expect(candidate[0]?.text).toBe(rendered.summary);
  });

  test("R3-accounting: the real renderer silently drops source literals when its section fills", () => {
    const paths = Array.from({ length: 100 }, (_, index) => `src/file${String(index).padStart(3, "0")}.ts`);
    const { summary, literals, plan } = fixture([message("assistant", `${"x".repeat(5000)} ${paths.join(" ")} ${"y".repeat(5000)}`, "many")]);
    const source = literals.filter((value) => value.entryId === "many");
    const section = summary.split("[Exact values]\n")[1]!.split("\n\n")[0]!;
    const shown = section.split("\n").filter((line) => line.startsWith("- [entry many] "));
    expect(source).toHaveLength(100);
    expect(shown).toHaveLength(65);
    expect(section).not.toMatch(/omitted/i);
    expect(checkQa(summary, plan).reason).toBeUndefined();
  });

  test("R3-floor-legit: a source-correct renderer can show only an omission when no failure fits", () => {
    const extra = Array.from({ length: 24 }, (_, index) => [
      message("user", `Direction ${index}: ${"x".repeat(5000)}`, `long-${index}`),
      message("assistant", "", `fail-${index}`, [{ tool_use_id: `fail-${index}`, tool: "Edit", input: { file_path: `src/${"p".repeat(1200)}-${index}.ts` }, text: "denied", isError: true }]),
    ]).flat();
    extra.unshift(message("assistant", "", "files", Array.from({ length: 100 }, (_, index) => ({ tool_use_id: `write-${index}`, tool: "Write", input: { file_path: `src/${"long".repeat(20)}-${index}.ts` }, text: "ok" }))));
    const { source, retained, literals, literalSource } = fixture(extra);
    const withoutBaselineFailure = source.filter((event) => !((event.kind === "toolCall" || event.kind === "toolResult") && event.toolCallId === "read1"));
    const { sections } = projectWithMetadata(withoutBaselineFailure, retained);
    const rendered = renderSummaryWithMetadata(sections, { firstEntryId: "u0", lastEntryId: "a3", lastTimestamp: "", literals, earlierSummary: "c".repeat(100000), requestLines: ["r".repeat(5000)] });
    const block = rendered.summary.split("[Outstanding Context]")[1]?.split("\n\n")[0] ?? "";
    const failures = sourceFailures(withoutBaselineFailure);
    const shortestRecord = Math.min(...failures.map((line) => utf8Bytes(`[Outstanding Context]\n${clipUtf8(line, MAX_RENDERED_LINE_BYTES)}`)));
    expect(failures).toHaveLength(24);
    expect(block).toBe("\n… omitted 24 rendered lines");
    expect(rendered.qaBudgets.historyBlocks["[Outstanding Context]"]).toBe(951);
    expect(shortestRecord).toBe(1046);
    const plan = qaPlan(withoutBaselineFailure, retained, { ...literalSource, earlierSummary: "c".repeat(100000) }, rendered.qaBudgets, ["r".repeat(5000)]);
    const change = `Last change: Write src/${"long".repeat(20)}-99.ts`;
    expect(rendered.summary).not.toContain(change);
    expect(checkQa(rendered.summary, plan).reason).toBeUndefined();
  });

  test("R3-2-history: an honest omission of all rendered lines is admitted; a wrong or missing count is refused", () => {
    const extra = Array.from({ length: 24 }, (_, index) => [
      message("user", `Direction ${index}: ${"x".repeat(5000)}`, `long-${index}`),
      message("assistant", "", `fail-${index}`, [{ tool_use_id: `fail-${index}`, tool: "Edit", input: { file_path: `src/failed-${index}.ts` }, text: `denied ${"e".repeat(100)}`, isError: true }]),
    ]).flat();
    extra.unshift(message("assistant", "", "files", Array.from({ length: 100 }, (_, index) => ({ tool_use_id: `write-${index}`, tool: "Write", input: { file_path: `src/${"long".repeat(20)}-${index}.ts` }, text: "ok" }))));
    const { source, retained, sections, literals, literalSource } = fixture(extra);
    const healthy = renderSummaryWithMetadata(sections, { firstEntryId: "u0", lastEntryId: "a3", lastTimestamp: "", literals });
    const wrong = { ...sections, outstanding: ["… omitted 25 rendered lines"] };
    const rendered = renderSummaryWithMetadata(wrong, { firstEntryId: "u0", lastEntryId: "a3", lastTimestamp: "", literals });
    expect(rendered.summary).not.toContain("failed-0.ts");
    expect(rendered.qaBudgets.historyBlocks["[Outstanding Context]"]!).toBeLessThan(healthy.qaBudgets.historyBlocks["[Outstanding Context]"]!);
    const plan = qaPlan(source, retained, literalSource, rendered.qaBudgets);
    const change = `Last change: Write src/${"long".repeat(20)}-99.ts`;
    expect(rendered.summary).not.toContain(change);
    expect(checkQa(rendered.summary, plan).reason).toBeUndefined();
    const changedBudget = { ...rendered.qaBudgets, historyBlocks: { ...rendered.qaBudgets.historyBlocks, "[Outstanding Context]": 2491 } };
    expect(checkQa(rendered.summary, qaPlan(source, retained, literalSource, changedBudget)).reason).toBeUndefined();
    const short = replaceInSection({ summary: rendered.summary, plan }, "[Outstanding Context]", "… omitted 25 rendered lines", "… omitted 24 rendered lines");
    const absent = replaceInSection({ summary: rendered.summary, plan }, "[Outstanding Context]", "\n… omitted 25 rendered lines", "");
    expect(checkQa(short.summary, short.plan).reason).toBe("open failures");
    expect(checkQa(absent.summary, absent.plan).reason).toBe("open failures");
    const statusAbsent = replaceInSection({ summary: rendered.summary, plan }, "[Current Status]", "\n… omitted 1 rendered lines", "");
    const statusWrong = replaceInSection({ summary: rendered.summary, plan }, "[Current Status]", "… omitted 1 rendered lines", "… omitted 2 rendered lines");
    expect(checkQa(statusAbsent.summary, statusAbsent.plan).reason).toBe("last modification");
    expect(checkQa(statusWrong.summary, statusWrong.plan).reason).toBe("last modification");
  });

  test("R3-4: no successful modification refuses an invented last change", () => {
    const { source, retained, literalSource, literals } = fixture();
    const noChanges = source.filter((event) => !(event.kind === "toolCall" && event.toolCallId === "edit1") && !(event.kind === "toolResult" && event.toolCallId === "edit1"));
    const { sections } = projectWithMetadata(noChanges, retained);
    const wrong = { ...sections, status: [...sections.status, "Last change: Edit invented.ts"] };
    const rendered = renderSummaryWithMetadata(wrong, { firstEntryId: "u0", lastEntryId: "a3", lastTimestamp: "", literals });
    expect(rendered.summary).toContain("Last change: Edit invented.ts");
    expect(checkQa(rendered.summary, qaPlan(noChanges, retained, literalSource, rendered.qaBudgets)).reason).toBe("last modification");
  });

  test("R3-1: a literal record with a suffix is not the original value", () => {
    const { summary, plan } = fixture([message("assistant", "The path is src/assistant.ts", "assistant-value")]);
    const line = "- [entry assistant-value] src/assistant.ts";
    expect(summary).toContain(`${line}\n`);
    const wrong = replaceInSection({ summary, plan }, "[Exact values]", line, `${line}.bak`);
    const duplicate = replaceInSection({ summary, plan }, "[Exact values]", line, `${line}\n${line}`);
    expect(checkQa(wrong.summary, wrong.plan).reason).toBe("exact values");
    expect(checkQa(duplicate.summary, duplicate.plan).reason).toBe("exact values");
  });

  test("sound literals: invented records are refused even when expected records remain", () => {
    const { summary, plan } = fixture([message("assistant", "The path is src/assistant.ts", "assistant-value")]);
    const line = "- [entry assistant-value] src/assistant.ts";
    const wrong = replaceInSection({ summary, plan }, "[Exact values]", line, `${line}\n- [entry forged] src/invented.ts`);
    expect(checkQa(wrong.summary, wrong.plan).reason).toBe("exact values");
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
    const wrong = { ...sections, outstanding: ["… omitted 1 error records later resolved by an exact retry"] };
    const forged = renderSummaryWithMetadata(wrong, { firstEntryId: "u0", lastEntryId: "a3", lastTimestamp: "", literals });
    expect(checkQa(forged.summary, qaPlan(source, retained, literalSource, forged.qaBudgets)).reason).toBe("open failures");
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
