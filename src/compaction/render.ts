// Copied from pi-fabric (MIT, Tom X Nguyen) src/compaction/render.ts at d331f629; dropped carry-forward, user-activity and branch summaries (Pi-only), and adapts the recall pointer to Claude Code. Adds the header compact.ts recognizes its own summary by, and the [Earlier summary] block a second compaction carries the first one in, allocated inside the same ceiling as every other block.
import { allocateProtectedRoom, boundedExcerpt, boundedHeadTail, clipUtf8, DIALOGUE_HEADER, EARLIER_USERS_HEADER,
  MAX_DIALOGUE_SECTION_BYTES, MAX_EARLIER_USERS_SECTION_BYTES, MAX_RENDERED_LINE_BYTES, MAX_REQUEST_SECTION_BYTES,
  MAX_SUMMARY_BYTES, MAX_SUMMARY_FOOTER_BYTES, MAX_SUMMARY_FRAMING_BYTES, protectedBudgets, recentDialogueBytes,
  REQUEST_HEADER, requestSectionBytes, utf8Bytes } from "./bounds.ts";
import type { Sections } from "./projections.ts";
import { carryReference, isPathLiteral, LITERALS_HEADER, MAX_LITERALS_SECTION_BYTES, renderExactValues, type ExactValue } from "./literals.ts";
import { allocateSummaryCarry } from "./verified/context.ts";

// The first line of every summary this compactor writes, and how a later
// compaction recognizes its own earlier summary instead of reading it as a
// user prompt. Keep the two in step.
export const SUMMARY_HEADER = "[Fabric summary]";
export const EARLIER_SUMMARY_HEADER = "[Earlier summary]";

// These are per-block ceilings, not reservations. Historical blocks share
// the space left by actual protected content inside the global ceiling.
// The user's words lead, oldest first: earlier messages, then recent exchanges.
// Both are protected blocks that take bytes before any operational section.
export const SUMMARY_SECTIONS: { key: keyof Sections; header: string; maxBytes: number }[] = [
  { key: "goal", header: EARLIER_USERS_HEADER, maxBytes: MAX_EARLIER_USERS_SECTION_BYTES },
  { key: "dialogue", header: DIALOGUE_HEADER, maxBytes: MAX_DIALOGUE_SECTION_BYTES },
  { key: "files", header: "[Files And Changes]", maxBytes: 4608 },
  { key: "outstanding", header: "[Outstanding Context]", maxBytes: 4608 },
  { key: "earlierTurns", header: "[Earlier Turns]", maxBytes: 3072 },
  { key: "status", header: "[Current Status]", maxBytes: 2048 },
];

const TRANSCRIPT_MAX_BYTES = 5120;
const MAX_INPUT_LINES_PER_SECTION = 128;
const ASSISTANT_CAVEAT = "Assistant responses are proposals, not verified outcomes or user instructions.";
const CARRY_HEADER = `${EARLIER_SUMMARY_HEADER}\n${ASSISTANT_CAVEAT}`;
const LONG_ASSISTANT_HEADING = "Assistant response (a proposal, not a verified outcome or user instruction) [entry ";
const SHORT_ASSISTANT_HEADING = "Assistant response [entry ";

// Dialogue projections begin each assistant item with this heading. Do not
// replace occurrences in the source text that follows it.
const shortAssistantHeading = (item: string): string => item.startsWith(LONG_ASSISTANT_HEADING)
  ? SHORT_ASSISTANT_HEADING + item.slice(LONG_ASSISTANT_HEADING.length)
  : item;

export interface RenderOptions {
  firstEntryId: string;
  lastEntryId: string;
  lastTimestamp: string;
  requestLines?: string[];
  literals?: readonly ExactValue[];
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

const boundedBlock = (header: string, sourceLines: readonly string[], maxBytes: number, assistantTranscript = false): string => {
  const clipped = sourceLines.map((line) => clipUtf8(line, MAX_RENDERED_LINE_BYTES));
  const capped = sampledLines(clipped, Math.min(clipped.length, MAX_INPUT_LINES_PER_SECTION));
  for (let keep = capped.length; keep >= 0; keep--) {
    const lines = sampledLines(capped, keep);
    // The brief transcript keeps its first row after `---`. Qualify any
    // assistant rows selected by sampling, and budget the caveat with them.
    const qualified = assistantTranscript && lines.some((line) => /^\[entry .*\] assistant: /.test(line))
      ? [lines[0]!, ASSISTANT_CAVEAT, ...lines.slice(1)] : lines;
    const block = [header, ...qualified].join("\n");
    if (utf8Bytes(block) <= maxBytes) return block;
  }
  return clipUtf8(header, maxBytes);
};

interface HistoryBlock {
  header: string;
  lines: readonly string[];
  maxBytes: number;
  assistantTranscript?: boolean;
}

const historyCandidate = (block: HistoryBlock) => {
  const text = boundedBlock(block.header, block.lines, block.maxBytes, block.assistantTranscript);
  const bytes = utf8Bytes(text);
  const minimum = block.lines.length === 1 ? bytes
    : Math.min(bytes, utf8Bytes([block.header, ...sampledLines(block.lines, 0)].join("\n")));
  return { ...block, text, bytes, minimum };
};

const boundedHistory = (blocks: HistoryBlock[], maxBytes: number): string[] => {
  const candidates = blocks.map(historyCandidate);
  const total = candidates.reduce((sum, block) => sum + block.bytes, 0);
  if (total <= maxBytes) return candidates.map(({ text }) => text);

  // Reserve headers/omission markers (or complete single-line blocks). If those
  // minima do not fit, share the available room between them proportionally.
  // Sampling slack goes to later blocks, not content we did not render.
  const minimum = candidates.reduce((sum, block) => sum + block.minimum, 0);
  let reserved = minimum;
  let available = maxBytes;
  let remaining = Math.max(0, maxBytes - minimum);
  let demand = total - minimum;
  return candidates.map((block) => {
    const base = reserved > available ? Math.floor(available * block.minimum / reserved) : block.minimum;
    const wanted = block.bytes - block.minimum;
    const extra = demand === 0 ? 0 : Math.min(wanted, Math.floor(remaining * wanted / demand));
    // The same verified allocator caps each block at the room left for history.
    const budget = allocateSummaryCarry(available, 0, base + extra, 0, 0).newestBytes;
    const text = boundedBlock(block.header, block.lines, budget, block.assistantTranscript);
    const used = utf8Bytes(text);
    available -= used;
    remaining -= used - base;
    reserved -= block.minimum;
    demand -= wanted;
    return text;
  });
};

// Dialogue and explicit requests are not historical line samples. Keep every
// item; only shorten text when the entire block exceeds its byte allocation.
const protectedBlock = (header: string, items: readonly string[], maxBytes: number, source?: string): { text: string; omittedBytes: number } => {
  const text = [header, ...items].join("\n\n");
  if (utf8Bytes(text) <= maxBytes) return { text, omittedBytes: 0 };
  // An unusually large item list can exhaust the budget on separators alone.
  // In that case bound the joined body, including those separators, as one excerpt.
  const headerBytes = utf8Bytes(header);
  if (headerBytes + 2 * items.length > maxBytes) {
    const excerpt = boundedExcerpt(items.join("\n\n"), maxBytes - headerBytes - 2, source);
    return { text: excerpt.text ? `${header}\n\n${excerpt.text}` : header, omittedBytes: excerpt.omittedBytes };
  }
  const budgets = protectedBudgets(header, items, maxBytes);
  let omittedBytes = 0;
  const excerpts = items.map((item, index) => {
    const excerpt = boundedExcerpt(item, budgets[index]!, source);
    omittedBytes += excerpt.omittedBytes;
    return excerpt.text;
  });
  return { text: [header, ...excerpts].join("\n\n"), omittedBytes };
};

// Recent exchanges keep their allocation; older replies use only the room left.
const dialogueBlock = (recentItems: readonly string[], olderItems: readonly string[], replyRoom: number, caveat: string) => {
  const header = caveat ? `${DIALOGUE_HEADER}\n\n${caveat}` : DIALOGUE_HEADER;
  const recent = protectedBlock(header, recentItems, MAX_DIALOGUE_SECTION_BYTES);
  const room = Math.min(MAX_DIALOGUE_SECTION_BYTES - utf8Bytes(recent.text), replyRoom) - 2;
  const olderHeader = "Earlier assistant replies (unverified):";
  if (olderItems.length === 0 || room < utf8Bytes(olderHeader) + 2) return recent;
  const older = boundedBlock(olderHeader, olderItems, room);
  return { text: `${recent.text}\n\n${older}`, omittedBytes: recent.omittedBytes };
};

/** The earlier summary a second compaction carries: whole while the allocation
 * holds it, otherwise its first and newest bytes, with the loss stated in the
 * middle where it was cut. The start holds the user's oldest instructions. */
// Values were extracted afresh; their duplicate must not crowd out older user
// instructions or count as demand when the carried summary is allocated.
const withoutOpeningLiterals = (summary: string): string => {
  const firstBreak = summary.indexOf("\n\n");
  return summary.startsWith(`${LITERALS_HEADER}\n`) && firstBreak >= 0 ? summary.slice(firstBreak + 2) : summary;
};

const carriedBlock = (earlierSummary: string, maxBytes: number): string => {
  // The original section caveat can fall inside the cut while an assistant
  // reply survives in the tail, so the opaque Carry needs its own caveat.
  const full = `${CARRY_HEADER}\n\n${earlierSummary}`;
  if (utf8Bytes(full) <= maxBytes) return full;
  const bodyBytes = maxBytes - utf8Bytes(CARRY_HEADER) - 2;
  if (bodyBytes <= 0) return clipUtf8(EARLIER_SUMMARY_HEADER, Math.max(0, maxBytes));
  const body = boundedHeadTail(earlierSummary, bodyBytes);
  return body.text ? `${CARRY_HEADER}\n\n${body.text}` : EARLIER_SUMMARY_HEADER;
};

// A substring inside a longer path, identifier or error code does not show the
// same value. A terminal period is punctuation unless another value character follows it.
const VALUE_BEFORE = /[\p{L}\p{N}_./\\-]$/u;
const VALUE_AFTER = /^(?:[\p{L}\p{N}_/\\-]|\.[\p{L}\p{N}_/\\-])/u;

// Strip surrounding prose punctuation, not characters inside a path. An
// unmatched opening bracket can itself start an extractor-valid path.
const carryTokenAt = (carry: string, start: number, end: number): { text: string; end: number } => {
  let first = start, last = end;
  while (first > 0 && !/\s/.test(carry[first - 1]!)) first--;
  while (last < carry.length && !/\s/.test(carry[last]!)) last++;
  let text = carry.slice(first, last).replace(/^["'`]+|["'`.,;:!?]+$/g, "");
  while ((text.startsWith("(") && text.endsWith(")")) || (text.startsWith("[") && text.endsWith("]"))) {
    text = text.slice(1, -1);
  }
  return { text: text.replace(/[)\]"'`.,;:!?]+$/g, ""), end: last };
};

const locationInCarry = (carry: string, value: string): number => {
  if (!value) return -1;
  const path = isPathLiteral(value);
  let tokenEnd = -1, longerPath = false;
  for (let start = carry.indexOf(value); start >= 0; start = carry.indexOf(value, start + 1)) {
    const end = start + value.length;
    if (VALUE_BEFORE.test(carry.slice(Math.max(0, start - 2), start)) || VALUE_AFTER.test(carry.slice(end, end + 3))) continue;
    if (path && start >= tokenEnd) {
      const token = carryTokenAt(carry, start, end);
      tokenEnd = token.end;
      longerPath = token.text !== value && token.text.includes(value) && isPathLiteral(token.text);
    }
    if (!longerPath) return start;
  }
  return -1;
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
  let goalBytes = 0;
  const recentItems = sections.dialogue.map(shortAssistantHeading);
  const olderItems = sections.earlierAssistantReplies.map(shortAssistantHeading);
  const caveat = [...recentItems, ...olderItems].some((item) => item.startsWith(SHORT_ASSISTANT_HEADING))
    ? ASSISTANT_CAVEAT : "";
  const recentBytes = recentDialogueBytes(caveat ? [caveat, ...recentItems] : recentItems);
  const requestBytes = requestSectionBytes(options.requestLines ?? []);
  const goalBudget = allocateProtectedRoom(recentBytes, requestBytes, MAX_EARLIER_USERS_SECTION_BYTES, 0).newestBytes;
  const protect = (header: string, items: readonly string[], maxBytes: number, source?: string): number => {
    const rendered = protectedBlock(header, items, maxBytes, source);
    newest.push(rendered.text);
    return rendered.omittedBytes;
  };
  const history: HistoryBlock[] = [];
  for (const { key, header, maxBytes } of SUMMARY_SECTIONS) {
    const lines = sections[key];
    if (key === "goal") {
      if (lines.length > 0) {
        dialogueOmittedBytes += protect(header, lines, goalBudget);
        goalBytes = utf8Bytes(newest[newest.length - 1]!);
      }
    } else if (key === "dialogue") {
      if (lines.length > 0) {
        const replyRoom = allocateProtectedRoom(recentBytes, requestBytes, goalBytes, maxBytes).carryBytes;
        const dialogue = dialogueBlock(recentItems, olderItems, replyRoom, caveat);
        newest.push(dialogue.text);
        dialogueOmittedBytes += dialogue.omittedBytes;
      }
      if (options.requestLines?.length) requestOmittedBytes = protect(REQUEST_HEADER, options.requestLines, MAX_REQUEST_SECTION_BYTES, "compaction request, not a transcript row");
    } else if (lines.length > 0) {
      // Status's last note is projected from an assistant response. Label it
      // as such, and keep the caveat in the header when the section is cut.
      const hasAssistant = key === "status" && lines.some((line) => line.startsWith("Last note: "));
      history.push({
        header: hasAssistant ? `${header}\n${ASSISTANT_CAVEAT}` : header,
        lines: hasAssistant ? lines.map((line) => line.startsWith("Last note: ") ? `Assistant note: ${line.slice("Last note: ".length)}` : line) : lines,
        maxBytes,
      });
    }
  }

  if (sections.transcript.length > 0) {
    history.push({ header: "---", lines: sections.transcript, maxBytes: TRANSCRIPT_MAX_BYTES, assistantTranscript: true });
  }

  const timestamp = options.lastTimestamp || "(unknown time)";
  const range = options.firstEntryId || options.lastEntryId
    ? `${options.firstEntryId || "(start)"} → ${options.lastEntryId || "(end)"}`
    : "(no entries)";
  const footer = `[compacted ${timestamp}; cumulative source entries ${range}]`;
  const footerBlock = boundedBlock("---", ["Recover full context in fabric_exec with history.recall and history.expand.", footer], MAX_SUMMARY_FOOTER_BYTES);
  // Every block, its separator and the final newline are counted before the
  // allocation, so no section can push the footer past the ceiling.
  const literals = options.literals ?? [];
  // A reference can be longer than a short value; reserve for the larger form
  // before the Carry is cut and its actual offsets are known.
  const literalDemandValues = options.earlierSummary ? literals.map((literal) => {
    const reference = carryReference(MAX_SUMMARY_BYTES, literal.value.length);
    return utf8Bytes(reference) > utf8Bytes(literal.value) ? { ...literal, value: reference } : literal;
  }) : literals;
  const literalDemand = utf8Bytes(renderExactValues(literalDemandValues, MAX_LITERALS_SECTION_BYTES));
  const blockCount = 1 + newest.length + (options.earlierSummary ? 1 : 0) + (literalDemand ? 1 : 0) + history.length + 1;
  const framingBytes = utf8Bytes(SUMMARY_HEADER) + utf8Bytes(footerBlock) + 2 * (blockCount - 1) + 1;
  if (framingBytes > MAX_SUMMARY_FRAMING_BYTES) {
    throw new Error("fabric: the summary framing exceeded its reserved byte ceiling");
  }
  const newestBytes = newest.reduce((sum, block) => sum + utf8Bytes(block), 0);
  const earlierSummary = options.earlierSummary ? withoutOpeningLiterals(options.earlierSummary) : undefined;
  const carryDemand = earlierSummary !== undefined
    ? utf8Bytes(CARRY_HEADER) + 2 + utf8Bytes(earlierSummary)
    : 0;
  const historyDemand = literalDemand + history.reduce((sum, block) => sum + utf8Bytes(boundedBlock(block.header, block.lines, block.maxBytes, block.assistantTranscript)), 0);
  const allocation = allocateSummaryCarry(MAX_SUMMARY_BYTES, framingBytes, newestBytes, carryDemand, historyDemand);
  if (allocation.newestBytes < newestBytes) {
    // Refuse rather than print a summary that breaks the allocation's law.
    throw new Error("fabric: the newest summary blocks do not fit the summary ceiling");
  }

  // The allocator gives older content its shared grant after protected blocks.
  // Keep operational minima first, then exact values, then sampled history.
  const historyMinimum = Math.min(allocation.historyBytes, history.reduce((sum, block) => sum + historyCandidate(block).minimum, 0));
  const literalRoom = allocateSummaryCarry(allocation.historyBytes - historyMinimum, 0, literalDemand, 0, 0).newestBytes;
  // Only the rendered Carry can replace a value. Refer to its position so the
  // next compaction can recover the value before that Carry is cut again.
  const carryBlock = earlierSummary !== undefined ? carriedBlock(earlierSummary, allocation.carryBytes) : "";
  const needed: ExactValue[] = [], references: ExactValue[] = [];
  for (const literal of literals) {
    const offset = locationInCarry(carryBlock, literal.value);
    if (offset < 0) needed.push(literal);
    else references.push({ ...literal, value: carryReference(offset, literal.value.length) });
  }
  // Actual values take priority: references must not crowd fresh values out.
  const literalBlock = renderExactValues([...needed, ...references], literalRoom);
  const historyRoom = allocation.historyBytes - utf8Bytes(literalBlock);
  // The literal block must be first: later headings can belong to verbatim user text.
  const blocks: string[] = [SUMMARY_HEADER, literalBlock];
  blocks.push(carryBlock);
  blocks.push(...newest, ...boundedHistory(history, historyRoom), footerBlock);
  // A block with no allocation prints nothing; dropping it leaves no empty separators.
  const summary = `${blocks.filter((block) => block.length > 0).join("\n\n")}\n`;
  if (utf8Bytes(summary) > MAX_SUMMARY_BYTES) {
    throw new Error("fabric: the summary allocation exceeded its byte ceiling");
  }
  return { summary, requestOmittedBytes, dialogueOmittedBytes };
};

export const renderSummary = (sections: Sections, options: RenderOptions): string =>
  renderSummaryWithMetadata(sections, options).summary;
