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
  const plan = qaPlan(source, retained, sections, literals, rendered.qaBudgets);
  return { messages, summary: rendered.summary, plan };
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
    const rendered = renderSummaryWithMetadata(sections, { firstEntryId: "u0", lastEntryId: "a3", lastTimestamp: "" });
    const plan = qaPlan(source, retained, sections, [], rendered.qaBudgets);
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
