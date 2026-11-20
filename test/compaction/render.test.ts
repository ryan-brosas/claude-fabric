// Adapted from pi-fabric (MIT, Tom X Nguyen) tests/compaction-render.test.ts at
// d331f629. Assertions are unchanged except where they tested a section or a
// summary kind this port dropped: [Fabric Activity], branch summaries, and the
// memory.recall pointer line.
import { describe, expect, test } from "bun:test";
import { MAX_SUMMARY_BYTES, utf8Bytes } from "../../src/compaction/bounds.ts";
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
