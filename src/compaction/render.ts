// Copied from pi-fabric (MIT, Tom X Nguyen) src/compaction/render.ts at d331f629; dropped carry-forward, user-activity and branch summaries (Pi-only), and adapts the recall pointer to Claude Code. Adds the header compact.ts recognizes its own summary by, and the [Earlier summary] block a second compaction carries the first one in, allocated inside the same ceiling as every other block.
import { boundedExcerpt, boundedHeadTail, clipUtf8, EARLIER_USERS_HEADER, MAX_EARLIER_USERS_SECTION_BYTES,
  MAX_RENDERED_LINE_BYTES, MAX_SUMMARY_BYTES, protectedBudgets, utf8Bytes } from "./bounds.ts";
import type { Sections } from "./projections.ts";
import { allocateSummaryCarry } from "./verified/context.ts";

// The first line of every summary this compactor writes, and how a later
// compaction recognizes its own earlier summary instead of reading it as a
// user prompt. Keep the two in step.
export const SUMMARY_HEADER = "[Fabric summary]";
export const EARLIER_SUMMARY_HEADER = "[Earlier summary]";
const REQUEST_HEADER = "[Compaction Request]";

// These are per-block ceilings, not reservations. Historical blocks share
// the space left by actual protected content inside the global ceiling.
// The user's words lead, oldest first: earlier messages, then recent exchanges.
// Both are protected blocks that take bytes before any operational section.
export const SUMMARY_SECTIONS: { key: keyof Sections; header: string; maxBytes: number }[] = [
  { key: "goal", header: EARLIER_USERS_HEADER, maxBytes: MAX_EARLIER_USERS_SECTION_BYTES },
  { key: "dialogue", header: "[Recent user directions and discussion]", maxBytes: 12288 },
  { key: "files", header: "[Files And Changes]", maxBytes: 4608 },
  { key: "outstanding", header: "[Outstanding Context]", maxBytes: 4608 },
  { key: "earlierTurns", header: "[Earlier Turns]", maxBytes: 3072 },
  { key: "status", header: "[Current Status]", maxBytes: 2048 },
];

const REQUEST_MAX_BYTES = 3072;
const TRANSCRIPT_MAX_BYTES = 5120;
const FOOTER_MAX_BYTES = 1536;
const MAX_INPUT_LINES_PER_SECTION = 128;

export interface RenderOptions {
  firstEntryId: string;
  lastEntryId: string;
  lastTimestamp: string;
  requestLines?: string[];
  /** The previous summary, used when transcript rebuilding fails. Carry it whole while
   * the allocation holds it; otherwise keep its start and end and state the middle cut. */
  earlierSummary?: string;
}

const sampledLines = (lines: readonly string[], keep: number): string[] => {
  if (lines.length <= keep) return [...lines];
  const earliest = Math.ceil(keep / 2);
  const latest = Math.floor(keep / 2);
  return [
    ...lines.slice(0, earliest),
    `… omitted ${lines.length - keep} rendered lines`,
    ...lines.slice(lines.length - latest),
  ];
};

const boundedBlock = (header: string, sourceLines: readonly string[], maxBytes: number): string => {
  const clipped = sourceLines.map((line) => clipUtf8(line, MAX_RENDERED_LINE_BYTES));
  const capped = sampledLines(clipped, Math.min(clipped.length, MAX_INPUT_LINES_PER_SECTION));
  for (let keep = capped.length; keep >= 0; keep--) {
    const lines = sampledLines(capped, keep);
    const block = [header, ...lines].join("\n");
    if (utf8Bytes(block) <= maxBytes) return block;
  }
  return clipUtf8(header, maxBytes);
};

interface HistoryBlock {
  header: string;
  lines: readonly string[];
  maxBytes: number;
}

const boundedHistory = (blocks: HistoryBlock[], maxBytes: number): string[] => {
  const candidates = blocks.map((block) => {
    const text = boundedBlock(block.header, block.lines, block.maxBytes);
    const bytes = utf8Bytes(text);
    const minimum = block.lines.length === 1 ? bytes
      : Math.min(bytes, utf8Bytes([block.header, ...sampledLines(block.lines, 0)].join("\n")));
    return { ...block, text, bytes, minimum };
  });
  const total = candidates.reduce((sum, block) => sum + block.bytes, 0);
  if (total <= maxBytes) return candidates.map(({ text }) => text);

  // Reserve headers/omission markers (or complete single-line blocks), then divide
  // remaining space proportionally to capped demand. Sampling slack goes to
  // later blocks rather than being reserved for content we did not render.
  const minimum = candidates.reduce((sum, block) => sum + block.minimum, 0);
  let remaining = maxBytes - minimum;
  let demand = total - minimum;
  return candidates.map((block) => {
    const wanted = block.bytes - block.minimum;
    const extra = demand === 0 ? 0 : Math.min(wanted, Math.floor(remaining * wanted / demand));
    const text = boundedBlock(block.header, block.lines, block.minimum + extra);
    remaining -= utf8Bytes(text) - block.minimum;
    demand -= wanted;
    return text;
  });
};

// Dialogue and explicit requests are not historical line samples. Keep every
// item; only shorten text when the entire block exceeds its byte allocation.
const protectedBlock = (header: string, items: readonly string[], maxBytes: number, source?: string): { text: string; omittedBytes: number } => {
  const text = [header, ...items].join("\n\n");
  if (utf8Bytes(text) <= maxBytes) return { text, omittedBytes: 0 };
  const budgets = protectedBudgets(header, items, maxBytes);
  let omittedBytes = 0;
  const excerpts = items.map((item, index) => {
    const excerpt = boundedExcerpt(item, budgets[index]!, source);
    omittedBytes += excerpt.omittedBytes;
    return excerpt.text;
  });
  return { text: [header, ...excerpts].join("\n\n"), omittedBytes };
};

/** The earlier summary a second compaction carries: whole while the allocation
 * holds it, otherwise its first and newest bytes, with the loss stated in the
 * middle where it was cut. The start holds the user's oldest instructions. */
const carriedBlock = (earlierSummary: string, maxBytes: number): string => {
  const full = `${EARLIER_SUMMARY_HEADER}\n\n${earlierSummary}`;
  if (utf8Bytes(full) <= maxBytes) return full;
  const bodyBytes = maxBytes - utf8Bytes(EARLIER_SUMMARY_HEADER) - 2;
  if (bodyBytes <= 0) return clipUtf8(EARLIER_SUMMARY_HEADER, Math.max(0, maxBytes));
  const body = boundedHeadTail(earlierSummary, bodyBytes);
  return body.text ? `${EARLIER_SUMMARY_HEADER}\n\n${body.text}` : EARLIER_SUMMARY_HEADER;
};

export interface RenderedSummary {
  summary: string;
  requestOmittedBytes: number;
  dialogueOmittedBytes: number;
}

export const renderSummaryWithMetadata = (sections: Sections, options: RenderOptions): RenderedSummary => {
  // The newest blocks, in the order they print. Their ceilings are demands, not
  // reservations: they take bytes before the carried summary and history do.
  const newest: string[] = [];
  let requestOmittedBytes = 0;
  let dialogueOmittedBytes = 0;
  const protect = (header: string, items: readonly string[], maxBytes: number, source?: string): number => {
    const rendered = protectedBlock(header, items, maxBytes, source);
    newest.push(rendered.text);
    return rendered.omittedBytes;
  };
  const history: HistoryBlock[] = [];
  for (const { key, header, maxBytes } of SUMMARY_SECTIONS) {
    const lines = sections[key];
    if (key === "goal") {
      if (lines.length > 0) dialogueOmittedBytes += protect(header, lines, maxBytes);
    } else if (key === "dialogue") {
      if (lines.length > 0) dialogueOmittedBytes += protect(header, lines, maxBytes);
      if (options.requestLines?.length) requestOmittedBytes = protect(REQUEST_HEADER, options.requestLines, REQUEST_MAX_BYTES, "compaction request, not a transcript row");
    } else if (lines.length > 0) {
      history.push({ header, lines, maxBytes });
    }
  }

  if (sections.transcript.length > 0) {
    history.push({ header: "---", lines: sections.transcript, maxBytes: TRANSCRIPT_MAX_BYTES });
  }

  const timestamp = options.lastTimestamp || "(unknown time)";
  const range = options.firstEntryId || options.lastEntryId
    ? `${options.firstEntryId || "(start)"} → ${options.lastEntryId || "(end)"}`
    : "(no entries)";
  const footer = `[compacted ${timestamp}; cumulative source entries ${range}]`;
  const footerBlock = boundedBlock("---", ["Recover full context in fabric_exec with history.recall and history.expand.", footer], FOOTER_MAX_BYTES);
  // Every block, its separator and the final newline are counted before the
  // allocation, so no section can push the footer past the ceiling.
  const blockCount = 1 + newest.length + (options.earlierSummary ? 1 : 0) + history.length + 1;
  const framingBytes = utf8Bytes(SUMMARY_HEADER) + utf8Bytes(footerBlock) + 2 * (blockCount - 1) + 1;
  const newestBytes = newest.reduce((sum, block) => sum + utf8Bytes(block), 0);
  const carryDemand = options.earlierSummary
    ? utf8Bytes(EARLIER_SUMMARY_HEADER) + 2 + utf8Bytes(options.earlierSummary)
    : 0;
  const historyDemand = history.reduce((sum, block) => sum + utf8Bytes(boundedBlock(block.header, block.lines, block.maxBytes)), 0);
  const allocation = allocateSummaryCarry(MAX_SUMMARY_BYTES, framingBytes, newestBytes, carryDemand, historyDemand);
  if (allocation.newestBytes < newestBytes) {
    // Unreachable while the newest ceilings (about 23 KiB) stay below the room a
    // 32 KiB summary leaves them. Refuse rather than print a summary that breaks
    // the allocation's law.
    throw new Error("fabric: the newest summary blocks do not fit the summary ceiling");
  }

  const blocks: string[] = [SUMMARY_HEADER];
  if (options.earlierSummary) blocks.push(carriedBlock(options.earlierSummary, allocation.carryBytes));
  blocks.push(...newest, ...boundedHistory(history, allocation.historyBytes), footerBlock);
  // A block with no allocation prints nothing; dropping it leaves no empty separators.
  const summary = `${blocks.filter((block) => block.length > 0).join("\n\n")}\n`;
  if (utf8Bytes(summary) > MAX_SUMMARY_BYTES) {
    throw new Error("fabric: the summary allocation exceeded its byte ceiling");
  }
  return { summary, requestOmittedBytes, dialogueOmittedBytes };
};

export const renderSummary = (sections: Sections, options: RenderOptions): string =>
  renderSummaryWithMetadata(sections, options).summary;
