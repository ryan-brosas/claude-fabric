// Adapted from pi-fabric (MIT, Tom X Nguyen) tests/compaction-render.test.ts at
// d331f629. Assertions are unchanged except where they tested a section or a
// summary kind this port dropped: [Fabric Activity], branch summaries, and the
// memory.recall pointer line.
import { describe, expect, test } from "bun:test";
import { MAX_SUMMARY_BYTES, utf8Bytes } from "../../src/compaction/bounds.ts";
import { project } from "../../src/compaction/projections.ts";
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
