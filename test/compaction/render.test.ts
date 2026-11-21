// Adapted from pi-fabric (MIT, Tom X Nguyen) tests/compaction-render.test.ts at
// d331f629. Assertions are unchanged except where they tested a section or a
// summary kind this port dropped: [Fabric Activity], branch summaries, and the
// memory.recall pointer line.
import { describe, expect, test } from "bun:test";
import { MAX_SUMMARY_BYTES, utf8Bytes } from "../../src/compaction/bounds.ts";
import { compact } from "../../src/compaction/compact.ts";
import { messageBytes, type ClaudeMessage } from "../../src/compaction/from-claude.ts";
import { project } from "../../src/compaction/projections.ts";
import { MAX_LITERALS_SECTION_BYTES, renderExactValues } from "../../src/compaction/literals.ts";
import { renderSummaryWithMetadata, SUMMARY_SECTIONS } from "../../src/compaction/render.ts";

const options = { firstEntryId: "first", lastEntryId: "last", lastTimestamp: "time" };
// Earlier user messages are a protected block now; the operational sections share what remains.
const historyKeys = ["files", "outstanding", "earlierTurns", "status", "transcript"] as const;

const history = (saturated = false) => {
  const sections = project([]);
  for (const key of historyKeys) {
    const count = saturated ? 128
      : key === "files" || key === "outstanding" || key === "transcript" ? 36
      : key === "status" ? 16 : 20;
    sections[key] = Array.from({ length: count }, (_, i) => `${key}-${i}: ${saturated ? "界🦊".repeat(30) : "x".repeat(75)} [entry ${key}-${i}]`);
  }
  // At most 64 earlier user messages reach the renderer (MAX_EARLIER_USERS).
  sections.goal = Array.from({ length: saturated ? 64 : 4 }, (_, i) => `User [entry u${i}]:\nGOAL_${i} ${saturated ? "界🦊".repeat(30) : "x".repeat(75)}`);
  return sections;
};

const historyText = (summary: string) => summary.slice(summary.indexOf("[Files And Changes]"));

describe("demand-based compaction rendering", () => {
  test("states the proposal caveat once and identifies each response in a real compaction", () => {
    const messages: ClaudeMessage[] = [];
    for (let index = 0; index < 5; index++) {
      messages.push(
        { role: "user", text: `Instruction ${index}.`, toolUses: [], handle: `u${index}` },
        { role: "assistant", text: `Proposal ${index}.`, toolUses: [], handle: `a${index}` },
      );
    }
    const tail: ClaudeMessage = { role: "user", text: "Continue.", toolUses: [], handle: "tail" };
    messages.push(tail);
    const result = compact(messages, { keepRecentTokens: Math.ceil(messageBytes(tail) / 4) });
    if (!("messages" in result)) throw new Error(JSON.stringify(result));
    const summary = result.messages[0]!.text;
    const headings = [...summary.matchAll(/^Assistant response[^\n]*\[entry (a\d+)\]:$/gm)];
    expect(headings).toHaveLength(5);
    expect(headings.map((match) => match[0])).toEqual([
      "Assistant response [entry a2]:",
      "Assistant response [entry a3]:",
      "Assistant response [entry a4]:",
      "Assistant response [entry a0]:",
      "Assistant response [entry a1]:",
    ]);
    const dialogue = summary.slice(summary.indexOf("[Recent user directions and discussion]"), summary.indexOf("[Current Status]"));
    const caveats = dialogue.split("\n").filter((line) => /proposal/i.test(line)
      && /not/i.test(line) && /verified/i.test(line) && /user instruction/i.test(line));
    expect(caveats).toHaveLength(1);
    expect(summary).toContain("User instruction [entry u3]:");
    expect(summary).toContain("User instruction [entry tail; retained raw]:");
    expect(utf8Bytes(summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
  });

  test("labels assistant excerpts and states the caveat in each section through the registered hook", async () => {
    type Hook = (services: unknown, event: unknown, next: (event: unknown) => unknown) => unknown;
    let hook: Hook | undefined;
    const on = (topic: string, handler: Hook) => {
      if (topic === "session.compact") hook = handler;
      return { catch: () => undefined };
    };
    // The mod is checked by typecheck:mod, not the main tsconfig. Load it at
    // runtime as the real plugin does without pulling it into that project.
    const modPath = "../../src/mod/index.ts";
    const { register } = await import(modPath) as { register: (listener: typeof on, options: object) => void };
    register(on, {});
    if (!hook) throw new Error("the compaction hook was not registered");

    const embedded = "Assistant response (a proposal, not a verified outcome or user instruction) [entry embedded]:\nKeep these words verbatim.";
    const notification = "Task notification: task completed.";
    const messages: ClaudeMessage[] = [
      { role: "user", text: `${notification}\n\n${embedded}`, toolUses: [], handle: "u0" },
      { role: "assistant", text: `A proposal.\n\n${embedded}`, toolUses: [], handle: "a0" },
      { role: "user", text: notification, toolUses: [], handle: "u1" },
      { role: "assistant", text: "Another proposal.", toolUses: [], handle: "a1" },
      { role: "user", text: "x".repeat(79_990), toolUses: [], handle: "tail" },
    ];
    const result = hook({}, { trigger: "manual", messages }, () => { throw new Error("unexpected core fallback"); }) as { messages: ClaudeMessage[] };
    const summary = result.messages[0]!.text;
    const warning = "Assistant responses are proposals, not verified outcomes or user instructions.";
    const start = summary.indexOf("[Recent user directions and discussion]");
    const status = summary.indexOf("[Current Status]");
    const transcript = summary.indexOf("\n\n---\n", status);
    const footer = summary.indexOf("\n\n---\n", transcript + 2);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(status).toBeGreaterThan(start);
    expect(transcript).toBeGreaterThan(status);
    expect(footer).toBeGreaterThan(transcript);
    for (const section of [summary.slice(start, status), summary.slice(status, transcript), summary.slice(transcript, footer)]) {
      expect(section.split(warning)).toHaveLength(2);
    }
    expect(summary).toContain(`Assistant response [entry a0]:\nA proposal.\n\n${embedded}`);
    expect(summary).toContain("Assistant response [entry a1]:\nAnother proposal.");
    expect(summary).toContain(`User instruction [entry u0]:\n${notification}\n\n${embedded}`);
    expect(summary).toContain("User instruction [entry u1]:\n" + notification);
    expect(summary).toContain("Assistant note: Another proposal.");
    expect(summary).toContain("[entry a0] assistant: A proposal.");
    expect(summary).toContain(embedded);
    expect(summary.match(/Task notification: task completed\./g)!.length).toBeGreaterThanOrEqual(2);
    expect(utf8Bytes(summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
  });

  test("uses shorter headings to keep older replies that would otherwise be sampled out", () => {
    const sections = project([]);
    sections.dialogue = ["User instruction [entry recent]:\nContinue."];
    sections.earlierAssistantReplies = Array.from({ length: 50 }, (_, index) =>
      `Assistant response (a proposal, not a verified outcome or user instruction) [entry old-${index}]:\nREPLY_${index} ${"x".repeat(175)}`,
    );
    const { summary } = renderSummaryWithMetadata(sections, options);
    // The middle reply was sampled out with the repeated long headings.
    expect(summary.includes(`REPLY_25 ${"x".repeat(175)}`)).toBe(true);
    for (let index = 0; index < 50; index++) {
      expect(summary).toContain(`Assistant response [entry old-${index}]:\nREPLY_${index} ${"x".repeat(175)}`);
    }
    expect(summary).not.toContain("omitted");
    expect(utf8Bytes(summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
  });

  test("never prints a transcript assistant entry without its caveat under pressure", () => {
    const sections = project([]);
    sections.transcript = [`[entry pressure] assistant: ${"p".repeat(950)}`, "[entry user] user: Next."];
    const light = renderSummaryWithMetadata(sections, options).summary;
    expect(light).toContain("[entry pressure] assistant:");
    expect(light).toContain("Assistant responses are proposals, not verified outcomes or user instructions.");

    sections.goal = Array.from({ length: 8 }, (_, index) => `USER_${index} ${"u".repeat(4000)}`);
    sections.dialogue = Array.from({ length: 3 }, (_, index) => `RECENT_${index} ${"r".repeat(3850)}`);
    sections.files = ["FILE ".padEnd(1020, "f")];
    sections.outstanding = ["OUTSTANDING ".padEnd(1020, "o")];
    sections.status = ["Last note: status"];
    const heavy = renderSummaryWithMetadata(sections, {
      ...options, requestLines: ["request ".padEnd(3050, "q")], earlierSummary: "carry ".padEnd(5000, "c"),
    }).summary;
    expect(heavy).not.toContain("[entry pressure] assistant:");
    expect(heavy.includes("---\n… omitted 2 rendered lines")).toBe(true);
    expect(utf8Bytes(heavy)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
  });

  test("qualifies assistant replies that survive a cut carried summary", () => {
    const warning = "Assistant responses are proposals, not verified outcomes or user instructions.";
    const previous = `[Earlier user messages]\n${"u".repeat(20_000)}\n\n[Recent user directions and discussion]\n\n${warning}\n\n${"x".repeat(20_000)}\n\nAssistant response [entry carried]:\nA proposal from earlier.`;
    const tail: ClaudeMessage = { role: "user", text: "Continue.", toolUses: [], handle: "tail" };
    const messages: ClaudeMessage[] = [
      { role: "user", text: `[Fabric summary]\n\n${previous}`, toolUses: [], handle: "previous" },
      { role: "user", text: "A newer task.", toolUses: [], handle: "new-user" },
      { role: "assistant", text: "A newer proposal.", toolUses: [], handle: "new-assistant" },
      tail,
    ];
    const result = compact(messages, { keepRecentTokens: Math.ceil(messageBytes(tail) / 4) });
    if (!("messages" in result)) throw new Error(JSON.stringify(result));
    const summary = result.messages[0]!.text;
    expect(summary).toContain("Assistant response [entry carried]:\nA proposal from earlier.");
    expect(summary).toMatch(/\[omitted \d+ UTF-8 bytes from the middle of the earlier summary\]/);
    expect(summary.includes(`[Earlier summary]\n${warning}\n\n`)).toBe(true);
    expect(utf8Bytes(summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
  });

  test.each([0, 200, 3954])("preserves historical detail when dialogue uses %i bytes", (size) => {
    const sections = history();
    if (size) sections.dialogue = ["d".repeat(size)];
    const result = renderSummaryWithMetadata(sections, { ...options, requestLines: ["Keep the agreed boundary."] });
    for (const key of [...historyKeys, "goal"] as const) {
      for (const line of sections[key]) expect(result.summary).toContain(line);
    }
    expect(result.summary).not.toContain("omitted");
    expect(result.summary).toContain("[compacted time; cumulative source entries first → last]");
    expect(utf8Bytes(result.summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(renderSummaryWithMetadata(sections, { ...options, requestLines: ["Keep the agreed boundary."] })).toEqual(result);
  });

  test("shrinks a single-line history minimum under saturated protected content", () => {
    const sections = project([]);
    sections.goal = Array.from({ length: 8 }, (_, i) => `GOAL_${i} `.padEnd(4096, "u"));
    sections.dialogue = Array.from({ length: 3 }, (_, i) => `DIRECTION_${i} `.padEnd(3900, "d"));
    sections.outstanding = ["OUTSTANDING ".padEnd(1024, "h")];
    const request = "PIN_REQUEST ".padEnd(3050, "q");
    const result = renderSummaryWithMetadata(sections, {
      ...options,
      requestLines: [request],
      earlierSummary: "CARRY ".padEnd(4000, "c"),
    });
    expect(utf8Bytes(result.summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(result.summary).toContain(request);
    for (const direction of sections.dialogue) expect(result.summary).toContain(direction);
    expect(result.summary).toContain("[Outstanding Context]\n… omitted 1 rendered lines");
    expect(result.summary).toContain("[compacted time; cumulative source entries first → last]");
  });

  test.each([
    { count: 1, unicode: false, carrySize: 4000 },
    { count: 1, unicode: true, carrySize: 20000 },
    { count: 2, unicode: false, carrySize: 20000 },
    { count: 11, unicode: true, carrySize: 4000 },
    { count: 128, unicode: false, carrySize: 20000 },
  ])("keeps every saturated section within the ceiling: $count lines, unicode=$unicode, carry=$carrySize", ({ count, unicode, carrySize }) => {
    const sections = project([]);
    sections.goal = Array.from({ length: 8 }, (_, i) => `GOAL_${i} `.padEnd(4096, "u"));
    sections.dialogue = Array.from({ length: 3 }, (_, i) => `DIRECTION_${i} `.padEnd(3900, "d"));
    for (const key of historyKeys) {
      sections[key] = Array.from({ length: count }, (_, i) => `${key}_${i} ${unicode ? "界🦊".repeat(350) : "h".repeat(1100)}`);
    }
    const request = "PIN_REQUEST ".padEnd(3050, "q");
    const literals = Array.from({ length: 200 }, (_, i) => ({ entryId: `source-${i}`, value: `BATCH-${i.toString(16).padStart(12, "0")}` }));
    const fullSection = renderExactValues(literals, MAX_LITERALS_SECTION_BYTES);
    expect(utf8Bytes(fullSection)).toBeGreaterThan(1950);
    expect(utf8Bytes(fullSection)).toBeLessThanOrEqual(MAX_LITERALS_SECTION_BYTES);
    const { summary } = renderSummaryWithMetadata(sections, {
      ...options,
      requestLines: [request], literals,
      earlierSummary: "CARRY ".padEnd(carrySize, "c"),
    });
    expect(utf8Bytes(summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(summary).toContain(request);
    for (const direction of sections.dialogue) expect(summary).toContain(direction);
    for (const { header } of SUMMARY_SECTIONS) expect(summary).toContain(header);
    const literalSection = summary.split("[Exact values]\n")[1]?.split("\n\n")[0];
    if (literalSection) expect(utf8Bytes(`[Exact values]\n${literalSection}`)).toBeLessThanOrEqual(MAX_LITERALS_SECTION_BYTES);
    expect(summary).toContain("[compacted time; cumulative source entries first → last]");
    expect(summary).not.toContain("\uFFFD");
  });

  test("bounds protected blocks when their item separators alone exceed the section budget", () => {
    const sections = project([]);
    sections.goal = Array.from({ length: 8 }, (_, i) => `GOAL_${i} `.padEnd(4096, "u"));
    sections.dialogue = Array.from({ length: 3 }, (_, i) => `DIRECTION_${i} `.padEnd(3900, "d"));
    const requests = Array.from({ length: 10000 }, (_, i) => `REQUEST_${i}`);
    const { summary, requestOmittedBytes } = renderSummaryWithMetadata(sections, { ...options, requestLines: requests });
    expect(utf8Bytes(summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    for (const direction of sections.dialogue) expect(summary).toContain(direction);
    expect(summary).toContain("REQUEST_0");
    expect(summary).toMatch(/\[omitted \d+ UTF-8 bytes of compaction request, not a transcript row\]/);
    expect(requestOmittedBytes).toBeGreaterThan(0);
    expect(summary).toContain("[compacted time; cumulative source entries first → last]");
  });

  test("bounds every protected block when all item lists exceed their separator budgets", () => {
    const sections = project([]);
    sections.goal = Array.from({ length: 10000 }, (_, i) => `GOAL_${i}`);
    sections.dialogue = Array.from({ length: 10000 }, (_, i) => `DIRECTION_${i}`);
    sections.outstanding = ["OUTSTANDING ".padEnd(1024, "h")];
    const requests = Array.from({ length: 10000 }, (_, i) => `REQUEST_${i}`);
    const { summary, dialogueOmittedBytes, requestOmittedBytes } = renderSummaryWithMetadata(sections, {
      ...options, requestLines: requests, earlierSummary: "CARRY ".padEnd(4000, "c"),
    });
    expect(utf8Bytes(summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(summary).toContain("GOAL_0");
    expect(summary).toContain("DIRECTION_0");
    expect(summary).toContain("REQUEST_0");
    expect(summary).toContain("[compacted time; cumulative source entries first → last]");
    expect(dialogueOmittedBytes).toBeGreaterThan(0);
    expect(requestOmittedBytes).toBeGreaterThan(0);
  });

  test("sampling reports the omitted count without a source range", () => {
    const sections = project([]);
    sections.files = Array.from({ length: 16 }, (_, i) => `${"x".repeat(650)} [entry source-${i}]`);
    const { summary } = renderSummaryWithMetadata(sections, options);
    expect(summary).toContain("… omitted 10 rendered lines\n");
    expect(utf8Bytes(summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
  });

  test("a clipped compaction request says it is not a transcript row", () => {
    const { summary, requestOmittedBytes } = renderSummaryWithMetadata(project([]), { ...options, requestLines: ["界".repeat(3000)] });
    expect(summary).toMatch(/\[omitted \d+ UTF-8 bytes of compaction request, not a transcript row\]/);
    expect(requestOmittedBytes).toBeGreaterThan(0);
    expect(utf8Bytes(summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
  });

  test("only reduces historical blocks when actual protected content causes pressure", () => {
    const sections = { ...history(true), goal: history().goal };
    const without = renderSummaryWithMetadata(sections, options);
    sections.dialogue = ["d".repeat(3000)];
    const small = renderSummaryWithMetadata(sections, options);
    expect(historyText(small.summary)).toBe(historyText(without.summary));
    sections.dialogue = Array.from({ length: 3 }, (_, i) => `EXCHANGE_${i}\n${"d".repeat(3900)}`);
    const large = renderSummaryWithMetadata(sections, { ...options, requestLines: ["request".repeat(2000)] });
    expect(utf8Bytes(historyText(large.summary))).toBeLessThan(utf8Bytes(historyText(small.summary)));
    for (const exchange of sections.dialogue) expect(large.summary).toContain(exchange);
    for (const { header } of SUMMARY_SECTIONS) expect(large.summary).toContain(header);
    expect(large.dialogueOmittedBytes).toBe(0);
    expect(large.requestOmittedBytes).toBeGreaterThan(0);
    expect(utf8Bytes(large.summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
  });

  test("keeps a request and recent exchanges before allocating users ahead of older replies", () => {
    const sections = project([]);
    sections.goal = [`User [entry user-1]:\nUSER_START ${"u".repeat(22000)}`];
    sections.dialogue = Array.from({ length: 3 }, (_, index) => `RECENT_${index} ${"r".repeat(3850)}`);
    sections.earlierAssistantReplies = ["Assistant response [entry old]:\nOLD_ASSISTANT_END"];
    const request = `KEEP_REQUEST ${"q".repeat(2950)}`;
    const { summary } = renderSummaryWithMetadata(sections, { ...options, requestLines: [request] });
    expect(summary).toContain(request);
    for (const exchange of sections.dialogue) expect(summary).toContain(exchange);
    expect(summary).toContain("USER_START");
    expect(summary).not.toContain("OLD_ASSISTANT_END");
    expect(utf8Bytes(summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
  });

  test("does not reserve space for removed carried literal lines", () => {
    const sections = project([]);
    sections.goal = Array.from({ length: 2 }, (_, i) => `User [entry u${i}]: ${"u".repeat(100)}`);
    sections.dialogue = Array.from({ length: 3 }, (_, i) => `EXCHANGE_${i} ${"r".repeat(3000)}`);
    for (const key of historyKeys) sections[key] = Array.from({ length: 128 }, (_, i) => `${key}-${i} ${"x".repeat(100)}`);
    const body = `CARRY_START ${"c".repeat(2000)} CARRY_END`;
    const literals = Array.from({ length: 100 }, (_, i) => ({ entryId: `s${i}`, value: `BATCH-${i.toString(16).padStart(12, "0")}` }));
    const duplicate = renderExactValues(literals, MAX_LITERALS_SECTION_BYTES);
    const plain = renderSummaryWithMetadata(sections, { ...options, earlierSummary: body });
    const withDuplicate = renderSummaryWithMetadata(sections, { ...options, earlierSummary: `${duplicate}\n\n${body}` });
    expect(withDuplicate.summary === plain.summary).toBe(true);
  });

  test.each([
    ["path extension", "src/foo.ts", "src/foo.tsx"],
    ["path suffix", "src/foo.ts", "src/foo.ts.backup"],
    ["parent path", "src/foo.ts", "lib/src/foo.ts"],
    ["id suffix", "BATCH-ab12", "BATCH-ab12cd"],
    ["id segment", "BATCH-ab12", "BATCH-ab12-extra"],
    ["id prefix", "BATCH-ab12", "XBATCH-ab12"],
    ["Unicode id prefix", "BATCH-ab12", "𐐀BATCH-ab12"],
    ["Unicode id suffix", "BATCH-ab12", "BATCH-ab12𐐀"],
    ["error-code suffix", "E4471", "E44712"],
    ["error-code prefix", "E4471", "XE4471"],
    ["error-code segment", "E4471", "E4471_extra"],
  ].flatMap(([kind, shorter, longer]) => [
    { kind, value: shorter!, carried: longer! },
    { kind, value: longer!, carried: shorter! },
  ]))("keeps a distinct $kind exact value $value when Carry holds $carried", ({ value, carried }) => {
    const { summary } = renderSummaryWithMetadata(project([]), {
      ...options, literals: [{ entryId: "fresh", value }], earlierSummary: `Use ${carried}.`,
    });
    const section = summary.split("[Exact values]\n")[1]?.split("\n\n")[0] ?? "";
    expect(summary).toContain(`Use ${carried}.`);
    expect(section).toContain(`[entry fresh] ${value}`);
  });

  test.each(["src/foo.ts", "BATCH-ab12", "E4471", "Release is violet-harbor."])
  ("deduplicates the complete value %s when Carry surrounds it with punctuation", (value) => {
    const { summary } = renderSummaryWithMetadata(project([]), {
      ...options, literals: [{ entryId: "fresh", value }], earlierSummary: `Use '${value}', then continue.`,
    });
    expect(summary).toContain(`Use '${value}', then continue.`);
    expect(summary).not.toContain(`[entry fresh] ${value}`);
  });

  test("finds a complete carried value after an earlier partial match", () => {
    const { summary } = renderSummaryWithMetadata(project([]), {
      ...options, literals: [{ entryId: "fresh", value: "src/foo.ts" }],
      earlierSummary: "Use src/foo.tsx, then src/foo.ts.",
    });
    expect(summary).toContain("Use src/foo.tsx, then src/foo.ts.");
    expect(summary).not.toContain("[entry fresh] src/foo.ts");
  });

  test("allocates the carried earlier summary inside the ceiling, keeping its start and its newest bytes", () => {
    const sections = history(true);
    sections.dialogue = Array.from({ length: 3 }, (_, i) => `EXCHANGE_${i}\n${"界🦊".repeat(2000)}`);
    // 36 KiB before its newest lines: far past any room the ceiling can leave it.
    const earlierSummary = `[Fabric summary]\n\n[Earlier user messages]\nOLDEST_CARRY_LINE ${"m".repeat(36000)}\nNEWEST_REGION_LINE\nLATEST_CARRY_LINE`;
    const renderOptions = { ...options, requestLines: ["PIN the request"], earlierSummary };
    const result = renderSummaryWithMetadata(sections, renderOptions);
    expect(utf8Bytes(result.summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(result.summary).toContain("[Earlier summary]");
    expect(result.summary).toMatch(/\[omitted \d+ UTF-8 bytes from the middle of the earlier summary\]/);
    // The carry keeps its start and its newest bytes, cuts the middle and says so.
    expect(result.summary).toContain("LATEST_CARRY_LINE");
    expect(result.summary).toContain("NEWEST_REGION_LINE");
    expect(result.summary).toContain("OLDEST_CARRY_LINE");
    expect(result.summary).not.toContain("m".repeat(36000));
    // Every section header, the request and the footer still print.
    for (const { header } of SUMMARY_SECTIONS) expect(result.summary).toContain(header);
    expect(result.summary).toContain("PIN the request");
    expect(result.summary).toContain("[compacted time; cumulative source entries first → last]");
    expect(result.summary).not.toContain("\uFFFD");
    expect(renderSummaryWithMetadata(sections, renderOptions)).toEqual(result);
  });

  test("keeps tiny sections, protected excerpts, and the footer under maximum pressure", () => {
    const sections = history(true);
    sections.dialogue = Array.from({ length: 3 }, (_, i) => `EXCHANGE_${i}\n${"界🦊".repeat(4000)}`);
    sections.status = ["Verified checkpoint: still blocked."];
    const renderOptions = { ...options, requestLines: Array.from({ length: 6 }, (_, i) => `PIN_${i} ${"界".repeat(3000)}`) };
    const result = renderSummaryWithMetadata(sections, renderOptions);
    for (let i = 0; i < 3; i++) expect(result.summary).toContain(`EXCHANGE_${i}`);
    for (let i = 0; i < 6; i++) expect(result.summary).toContain(`PIN_${i}`);
    // Every earlier user message keeps its address and opening words under maximum pressure.
    for (let i = 0; i < 64; i++) expect(result.summary).toContain(`User [entry u${i}]:\nGOAL_${i}`);
    for (const { header } of SUMMARY_SECTIONS) expect(result.summary).toContain(`${header}\n`);
    expect(result.summary).toContain(sections.status[0]);
    expect(result.summary).toContain("[compacted time; cumulative source entries first → last]");
    expect(result.summary).not.toContain("�");
    expect(result.dialogueOmittedBytes).toBeGreaterThan(0);
    expect(result.requestOmittedBytes).toBeGreaterThan(0);
    expect(utf8Bytes(result.summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(renderSummaryWithMetadata(sections, renderOptions)).toEqual(result);
  });
});
