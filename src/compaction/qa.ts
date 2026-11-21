// Source-based reconstruction checks. The byte grants are calculated from the
// same source and allocation rules as rendering, never from the candidate text.
import { DIALOGUE_HEADER, EARLIER_USERS_HEADER, MAX_DIALOGUE_SECTION_BYTES, MAX_RENDERED_LINE_BYTES, clipUtf8, protectedBudgets, boundedExcerpt, utf8Bytes } from "./bounds.ts";
import { projectDialogue, recentDialogue } from "./dialogue.ts";
import type { CompactionEvent } from "./from-claude.ts";
import { LITERALS_HEADER, renderExactValues, type ExactValue } from "./literals.ts";
import { projectOutstanding, type Sections } from "./projections.ts";
import { ASSISTANT_CAVEAT, boundedHistory, protectedBlock, shortAssistantHeading, SUMMARY_HEADER, SUMMARY_SECTIONS, type HistoryBlock, type RenderedSummary } from "./render.ts";
import { compactionQa } from "./verified/generated/compaction-qa.js";

export type QaReason = "original request" | "dialogue" | "exact values" | "open failures" | "last modification" | "recall footer";
interface Probe { reason: QaReason; section: string; expected: string; exact?: boolean; lastChange?: boolean; }
export interface QaPlan { probes: Probe[]; outerStart: number; historyStart: number; literalLength: number; }
type Budgets = RenderedSummary["qaBudgets"];

const HEADERS = [LITERALS_HEADER, "[Earlier summary]", EARLIER_USERS_HEADER, DIALOGUE_HEADER, "[Compaction Request]",
  "[Files And Changes]", "[Outstanding Context]", "[Earlier Turns]", "[Current Status]", "---"];

// History is sampled after the literals have taken their grant. Re-run the
// source-only sampler so a skipped line requires the actual omission marker.
const expectedHistory = (sections: Sections, room: number): Map<string, string> => {
  const blocks: HistoryBlock[] = [];
  for (const { key, header, maxBytes } of SUMMARY_SECTIONS) {
    if (key === "goal" || key === "dialogue") continue;
    const lines = sections[key];
    if (!lines.length) continue;
    const hasAssistant = key === "status" && lines.some((line) => line.startsWith("Last note: "));
    blocks.push({ header: hasAssistant ? `${header}\n${ASSISTANT_CAVEAT}` : header,
      lines: hasAssistant ? lines.map((line) => line.startsWith("Last note: ") ? `Assistant note: ${line.slice(11)}` : line) : lines,
      maxBytes });
  }
  if (sections.transcript.length) blocks.push({ header: "---", lines: sections.transcript, maxBytes: 5120, assistantTranscript: true });
  const result = boundedHistory(blocks, room);
  return new Map(blocks.map((block, index) => [block.header.split("\n")[0]!, result[index]!]));
};

const fallback = (expected: string): string =>
  expected.split("\n").find((line) => line.includes("omitted") && line.includes("rendered lines")) ?? "";

/** The source and cut are normalized and addressed by compact, before rendering. */
export const qaPlan = (events: CompactionEvent[], retained: CompactionEvent[], sections: Sections,
  literals: readonly ExactValue[], budgets: Budgets): QaPlan => {
  const probes: Probe[] = [];
  const add = (reason: QaReason, section: string, expected: string, exact = false): void => {
    probes.push({ reason, section, expected, ...(exact ? { exact: true } : {}) });
  };
  const exchanges = recentDialogue(events, retained);
  const first = events.find((event) => event.kind === "user" && event.text.trim());
  if (first && !exchanges.some(({ user }) => user.entryId === first.entryId)) {
    const marker = sections.goal[0]?.startsWith("… omitted ") && sections.goal[0].includes(" user messages; source entries ") ? sections.goal[0] : "";
    const items = marker ? sections.goal.slice(1) : sections.goal;
    const index = items.findIndex((item) => item.startsWith(`User [entry ${first.entryId}]:\n`));
    const header = marker ? `${EARLIER_USERS_HEADER}\n${marker}` : EARLIER_USERS_HEADER;
    let expected = index < 0 ? "" : items[index]!;
    if (expected && utf8Bytes([header, ...items].join("\n\n")) > budgets.goal) {
      if (utf8Bytes(header) + 2 * items.length > budgets.goal) {
        expected = boundedExcerpt(items.join("\n\n"), budgets.goal - utf8Bytes(header) - 2).text;
      } else {
        expected = boundedExcerpt(expected, protectedBudgets(header, items, budgets.goal)[index]!).text;
      }
    }
    add("original request", EARLIER_USERS_HEADER, expected);
  }
  const recent = projectDialogue(exchanges).lines.map(shortAssistantHeading);
  if (recent.length) {
    const older = sections.earlierAssistantReplies.map(shortAssistantHeading);
    const caveat = [...recent, ...older].some((item) => item.startsWith("Assistant response [entry ")) ? ASSISTANT_CAVEAT : "";
    const header = caveat ? `${DIALOGUE_HEADER}\n\n${caveat}` : DIALOGUE_HEADER;
    const expected = protectedBlock(header, recent, MAX_DIALOGUE_SECTION_BYTES).text;
    add(first && exchanges.some(({ user }) => user.entryId === first.entryId) ? "original request" : "dialogue", DIALOGUE_HEADER, expected);
    // A separate check retains the dialogue reason even if the first request is recent.
    if (first && exchanges.some(({ user }) => user.entryId === first.entryId)) add("dialogue", DIALOGUE_HEADER, expected);
  }
  const users = new Set(events.filter((event) => event.kind === "user").map((event) => event.entryId));
  const literalBlock = renderExactValues(literals, budgets.literals);
  for (const value of literals) {
    const line = `- [entry ${value.entryId}] ${value.value}`;
    if (users.has(value.entryId) && literalBlock.split("\n").includes(line)) add("exact values", LITERALS_HEADER, line);
  }
  const history = expectedHistory(sections, budgets.history);
  const outstanding = history.get("[Outstanding Context]") ?? "";
  const failures = projectOutstanding(events);
  // Sampling can drop a selected record only when its loss is stated. An empty
  // source ledger must also reject an invented resolution in this section.
  const omission = fallback(outstanding);
  const accounted = failures.every((line) => outstanding.includes(clipUtf8(line, MAX_RENDERED_LINE_BYTES)) || !!omission);
  if (!accounted) add("open failures", "[Outstanding Context]", "");
  else add("open failures", "[Outstanding Context]", outstanding, true);

  const last = [...events].reverse().find((event) => event.kind === "toolCall" && (event.name === "Edit" || event.name === "Write")
    && typeof (event.args.file_path ?? event.args.path ?? event.args.dir) === "string");
  if (last?.kind === "toolCall") {
    const path = String(last.args.file_path ?? last.args.path ?? last.args.dir);
    const result = events.find((event) => event.kind === "toolResult" && event.toolCallId === last.toolCallId);
    const section = result?.kind === "toolResult" && result.isError ? "[Outstanding Context]" : "[Current Status]";
    const block = history.get(section) ?? "";
    const line = block.split("\n").find((item) => item.includes(path) && item.includes(last.name)) ?? fallback(block);
    add("last modification", section, line ?? "");
    // A failure must not be introduced as the last successful change.
    if (result?.kind === "toolResult" && result.isError) {
      const status = history.get("[Current Status]") ?? "";
      const expectedLastChange = status.split("\n").find((item) => item.startsWith("Last change: "));
      probes.push({ reason: "last modification", section: "[Current Status]", expected: expectedLastChange ?? "", lastChange: true });
    }
  }
  add("recall footer", "footer", "Recover full context in fabric_exec with history.recall and history.expand.");
  return { probes, outerStart: budgets.outerStart, historyStart: budgets.historyStart, literalLength: literalBlock.length };
};

// Sections are located in their outer order. Exact values always lead; the
// footer is anchored at the end, not at a transcript's `---` line.
const sectionOf = (summary: string, header: string, outerStart: number, expected: string): string => {
  if (header === "footer") {
    const at = summary.lastIndexOf("\n\n---\n");
    return at < 0 ? "" : summary.slice(at + 2).trimEnd();
  }
  const start = summary.indexOf(`\n\n${header}\n`, header === LITERALS_HEADER ? 0 : Math.max(0, outerStart - 2));
  if (start < 0) return "";
  const from = start + 2;
  // These two sections have source-defined positions: exact values are first,
  // and earlier-user messages are the first protected block after any carry.
  if (header === LITERALS_HEADER && from !== SUMMARY_HEADER.length + 2) return "";
  if (header === EARLIER_USERS_HEADER && summary.slice(Math.min(from, outerStart), Math.max(from, outerStart)).trim()) return "";
  // A verbatim selected excerpt can itself contain section-looking text. Such a
  // heading belongs to the excerpt, not to the enclosing summary structure.
  const expectedAt = !expected ? -1 : summary.startsWith(expected, from) ? from : summary.indexOf(expected, from + header.length);
  const inExpected = (at: number): boolean => expectedAt >= 0 && at >= expectedAt && at < expectedAt + expected.length;
  let end = summary.length;
  for (const next of HEADERS) {
    if (next === header || next === LITERALS_HEADER || (next === "[Earlier summary]" && header !== LITERALS_HEADER)) continue;
    let at = summary.indexOf(`\n\n${next}\n`, from + header.length);
    while (at >= 0 && inExpected(at)) at = summary.indexOf(`\n\n${next}\n`, at + 2);
    if (at >= 0 && at < end) end = at;
  }
  return summary.slice(from, end);
};

export const checkQa = (summary: string, plan: QaPlan): { reason?: QaReason; required: number; satisfied: number } => {
  const failed: QaReason[] = [];
  let satisfied = 0;
  // The literal block precedes every outer section. Recalculate only its framing
  // length so a removed literal cannot shift a later probe onto carried text.
  const literalStart = summary.startsWith(`${SUMMARY_HEADER}\n\n${LITERALS_HEADER}\n`) ? SUMMARY_HEADER.length : -1;
  const literalEnd = literalStart < 0 ? -1 : summary.indexOf("\n\n", literalStart + 2);
  const actualLiteralLength = literalStart < 0 ? 0 : (literalEnd < 0 ? summary.length : literalEnd) - literalStart - 2;
  const outerStart = Math.max(0, plan.outerStart + actualLiteralLength - plan.literalLength);
  for (const probe of plan.probes) {
    const history = probe.section === "[Outstanding Context]" || probe.section === "[Current Status]";
    const sectionStart = history ? Math.max(0, plan.historyStart + actualLiteralLength - plan.literalLength) : outerStart;
    const section = sectionOf(summary, probe.section, sectionStart, probe.expected);
    let pass: boolean;
    if (probe.lastChange) {
      const lines = section.split("\n").filter((line) => line.startsWith("Last change: "));
      pass = probe.expected ? lines.length === 1 && lines[0] === probe.expected : lines.length === 0;
    } else pass = probe.exact ? section === probe.expected : !!probe.expected && section.includes(probe.expected);
    if (pass) satisfied++;
    else failed.push(probe.reason);
  }
  const required = plan.probes.length;
  const footer = plan.probes.some((probe) => probe.reason === "recall footer") ? 1 : 0;
  const admitted = compactionQa.step({}, compactionQa.init({}), { required, satisfied, footer }).scalars["out.admitted"] === 1;
  if (admitted) return { required, satisfied };
  return { reason: failed[0] ?? "recall footer", required, satisfied };
};
