// Source-based reconstruction checks. The byte grants are calculated from the
// same source and allocation rules as rendering, never from the candidate text.
import { DIALOGUE_HEADER, EARLIER_USERS_HEADER, MAX_DIALOGUE_SECTION_BYTES, MAX_EARLIER_USERS_SECTION_BYTES, MAX_RENDERED_LINE_BYTES, MAX_REQUEST_SECTION_BYTES, REQUEST_HEADER, allocateProtectedRoom, clipUtf8, protectedBudgets, boundedExcerpt, boundedHeadTail, boundedTailExcerpt, omissionLine, recentDialogueBytes, requestSectionBytes, utf8Bytes } from "./bounds.ts";
import { MAX_RECENT_EXCHANGES, type DialogueExchange } from "./dialogue.ts";
import type { CompactionEvent } from "./from-claude.ts";
import { LITERALS_HEADER } from "./literals.ts";
import { sourceLiterals, type LiteralSource } from "./qa-literals.ts";
import { MAX_EARLIER_USERS, MAX_USER_MESSAGE_BYTES } from "./projections.ts";
import { sourceEarlierTurns, sourceFailures, sourceFiles, sourceHistoryBlock, sourceStatus } from "./qa-history.ts";
import { ASSISTANT_CAVEAT, shortAssistantHeading, SUMMARY_HEADER, type RenderedSummary } from "./render.ts";
import { compactionQa, qaLatestModification, qaTally } from "./verified/generated/compaction-qa.js";

export type QaReason = "original request" | "dialogue" | "exact values" | "open failures" | "last modification" | "recall footer";
interface Probe { reason: QaReason; section: string; expected: string; exact?: boolean; lastChange?: boolean; }
export interface QaPlan { probes: Probe[]; outerStart: number; historyStart: number; outstandingStart: number; statusStart: number; literalLength: number; goalBlock: string; }
type Budgets = RenderedSummary["qaBudgets"];

const HEADERS = [LITERALS_HEADER, "[Earlier summary]", EARLIER_USERS_HEADER, DIALOGUE_HEADER, "[Compaction Request]",
  "[Files And Changes]", "[Outstanding Context]", "[Earlier Turns]", "[Current Status]", "---"];

// Reconstruct source exchange order, including a response crossing the cut.
const sourceExchanges = (events: readonly CompactionEvent[], retained: readonly CompactionEvent[]): DialogueExchange[] => {
  const exchanges: DialogueExchange[] = [];
  let assistant: DialogueExchange["assistant"];
  const visit = (source: readonly CompactionEvent[], isRetained: boolean): void => {
    for (const event of source) {
      if (event.kind === "assistantText" && event.text.trim()) {
        if (assistant?.entryId === event.entryId) assistant.text += `\n${event.text}`;
        else assistant = { entryId: event.entryId, text: event.text, retained: isRetained };
      } else if (event.kind === "user") {
        if (!isRetained || assistant?.retained === false) {
          exchanges.push({ user: { entryId: event.entryId, text: event.text, retained: isRetained }, ...(assistant ? { assistant } : {}) });
          if (exchanges.length > 64 + MAX_RECENT_EXCHANGES) exchanges.shift();
        }
        assistant = undefined;
      }
    }
  };
  visit(events, false);
  visit(retained, true);
  return exchanges;
};

const sourceOlderReplies = (window: readonly DialogueExchange[]): string[] => window.slice(0, -MAX_RECENT_EXCHANGES).flatMap(({ assistant }) => {
  if (!assistant || assistant.retained) return [];
  const excerpt = boundedTailExcerpt(assistant.text, 256, assistant.entryId).text;
  return [`Assistant response [entry ${assistant.entryId}]:\n${excerpt}`];
});

const sourceCarry = (summary: string, grant: number): string => {
  if (!summary) return "";
  const firstBreak = summary.indexOf("\n\n");
  const body = summary.startsWith(`${LITERALS_HEADER}\n`) && firstBreak >= 0 ? summary.slice(firstBreak + 2) : summary;
  const heading = `[Earlier summary]\n${ASSISTANT_CAVEAT}`;
  const full = `${heading}\n\n${body}`;
  if (utf8Bytes(full) <= grant) return full;
  const room = grant - utf8Bytes(heading) - 2;
  if (room <= 0) return clipUtf8("[Earlier summary]", Math.max(0, grant));
  const excerpt = boundedHeadTail(body, room).text;
  return excerpt ? `${heading}\n\n${excerpt}` : "[Earlier summary]";
};

// Construct expectations from events and documented grants, not from the
// projected goal or the renderer's protected-block producer.
const sourceDialogue = (exchanges: readonly DialogueExchange[]): string[] => exchanges.map(({ user, assistant }) => {
  const userHeading = `User instruction [entry ${user.entryId}${user.retained ? "; retained raw" : ""}]:`;
  const assistantHeading = assistant ? `Assistant response (a proposal, not a verified outcome or user instruction) [entry ${assistant.entryId}${assistant.retained ? "; retained raw" : ""}]:` : "";
  const available = Math.max(0, 3968 - utf8Bytes(userHeading + assistantHeading) - 8);
  const userText = user.retained ? "" : user.text;
  const assistantBytes = assistant && !assistant.retained ? utf8Bytes(assistant.text) : 0;
  const userBudget = assistant ? Math.max(available / 2, available - assistantBytes) : available;
  const userExcerpt = boundedExcerpt(userText, Math.floor(userBudget), user.entryId).text;
  const userItem = `${userHeading}\n${userExcerpt}`;
  if (!assistant) return userItem;
  const response = boundedExcerpt(assistant.retained ? "" : assistant.text, available - utf8Bytes(userExcerpt), assistant.entryId).text;
  return `${assistantHeading}\n${response}\n\n${userItem}`;
});

const sourceProtected = (header: string, items: readonly string[], grant: number, source?: string): string => {
  const complete = [header, ...items].join("\n\n");
  if (utf8Bytes(complete) <= grant) return complete;
  if (utf8Bytes(header) + 2 * items.length > grant) {
    const body = boundedExcerpt(items.join("\n\n"), grant - utf8Bytes(header) - 2, source).text;
    return body ? `${header}\n\n${body}` : header;
  }
  const grants = protectedBudgets(header, items, grant);
  return [header, ...items.map((item, index) => boundedExcerpt(item, grants[index]!, source).text)].join("\n\n");
};

const sourceGoal = (events: CompactionEvent[], exchanges: readonly DialogueExchange[], requestLines: readonly string[], grant: number) => {
  const recentIds = new Set(exchanges.map(({ user }) => user.entryId));
  const users = events.filter((event): event is Extract<CompactionEvent, { kind: "user" }> =>
    event.kind === "user" && !recentIds.has(event.entryId) && !!event.text.trim());
  const last = new Map(users.map((event, index) => [event.text, index]));
  const ranked = users.map((event, index) => ({ index, distinct: last.get(event.text) === index }))
    .sort((a, b) => Number(b.distinct) - Number(a.distinct) || b.index - a.index);
  const chosen = users.length > MAX_EARLIER_USERS ? [0, ...ranked.filter(({ index }) => index !== 0)
    .slice(0, MAX_EARLIER_USERS - 1).map(({ index }) => index)] : ranked.map(({ index }) => index);
  const kept = new Set(chosen);
  const omitted = users.filter((_, index) => !kept.has(index));
  const marker = omitted.length ? `${omissionLine(omitted.length, omitted[0]?.entryId, omitted.at(-1)?.entryId, "user messages")} (not necessarily consecutive); later directives may be omitted` : "";
  const header = marker ? `${EARLIER_USERS_HEADER}\n${marker}` : EARLIER_USERS_HEADER;
  const selected = users.filter((_, index) => kept.has(index));
  const item = (user: typeof users[number], room = MAX_USER_MESSAGE_BYTES) =>
    `User [entry ${user.entryId}]:\n${boundedExcerpt(user.text, Math.min(room, MAX_USER_MESSAGE_BYTES), user.entryId).text}`;
  const items = selected.map((user) => item(user));
  const initialGrant = allocateProtectedRoom(recentDialogueBytes(sourceDialogue(exchanges)), requestSectionBytes(requestLines), MAX_EARLIER_USERS_SECTION_BYTES, 0).newestBytes;
  if (utf8Bytes([header, ...items].join("\n\n")) > initialGrant) {
    const shares = protectedBudgets(header, [...items].reverse(), initialGrant).reverse();
    selected.forEach((user, index) => {
      if (utf8Bytes(items[index]!) <= shares[index]!) return;
      const heading = `User [entry ${user.entryId}]:\n`;
      items[index] = item(user, Math.max(0, shares[index]! - utf8Bytes(heading)));
    });
  }
  return { header, items, selected, block: items.length ? sourceProtected(header, items, grant) : "" };
};

const fallback = (expected: string): string =>
  expected.split("\n").find((line) => line.includes("omitted") && line.includes("rendered lines")) ?? "";

/** The source and cut are normalized and addressed by compact, before rendering. */
export const qaPlan = (events: CompactionEvent[], retained: CompactionEvent[],
  literalSource: LiteralSource, budgets: Budgets, requestLines: readonly string[] = []): QaPlan => {
  const probes: Probe[] = [];
  const add = (reason: QaReason, section: string, expected: string, exact = false): void => {
    probes.push({ reason, section, expected, ...(exact ? { exact: true } : {}) });
  };
  const window = sourceExchanges(events, retained);
  const exchanges = window.slice(-MAX_RECENT_EXCHANGES);
  const goal = sourceGoal(events, exchanges, requestLines, budgets.goal);
  const first = events.find((event) => event.kind === "user" && event.text.trim());
  if (first && !exchanges.some(({ user }) => user.entryId === first.entryId)) {
    const { header, items, selected } = goal;
    const index = selected.findIndex((user) => user.entryId === first.entryId);
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
  const recent = sourceDialogue(exchanges).map(shortAssistantHeading);
  let fullDialogue = "";
  if (recent.length) {
    const older = sourceOlderReplies(window);
    const caveat = [...recent, ...older].some((item) => item.startsWith("Assistant response [entry ")) ? ASSISTANT_CAVEAT : "";
    const header = caveat ? `${DIALOGUE_HEADER}\n\n${caveat}` : DIALOGUE_HEADER;
    const expected = sourceProtected(header, recent, MAX_DIALOGUE_SECTION_BYTES);
    const olderHeader = "Earlier assistant replies (unverified):";
    fullDialogue = older.length && budgets.olderReplies >= utf8Bytes(olderHeader) + 2
      ? `${expected}\n\n${sourceHistoryBlock(olderHeader, older, budgets.olderReplies)}` : expected;
    add(first && exchanges.some(({ user }) => user.entryId === first.entryId) ? "original request" : "dialogue", DIALOGUE_HEADER, expected);
    // A separate check retains the dialogue reason even if the first request is recent.
    if (first && exchanges.some(({ user }) => user.entryId === first.entryId)) add("dialogue", DIALOGUE_HEADER, expected);
  }
  const sourceRecent = sourceDialogue(exchanges);
  const projectedGoal = [goal.header.includes("\n") ? goal.header.split("\n").slice(1).join("\n") : "", ...goal.items];
  const protectedText = [...projectedGoal, ...sourceRecent].join("\n\n");
  const wholeUsers = new Set(literalSource.messages.slice(0, literalSource.start).flatMap((message) => {
    const id = message.handle ?? message.uuid;
    return message.role === "user" && message.text && id &&
      (goal.items.includes(`User [entry ${id}]:\n${message.text}`) || sourceRecent.some((line) => line.includes(`User instruction [entry ${id}]:\n${message.text}`))) ? [id] : [];
  }));
  const values = sourceLiterals(literalSource, wholeUsers, protectedText);
  const framing = `${LITERALS_HEADER}\nUnverified excerpts. Source ids; Recall expansion is best-effort.`;
  let literalBlock = framing;
  let used = utf8Bytes(framing);
  let count = 0;
  for (const value of values) {
    const line = `- [entry ${value.entryId}] ${value.value}`;
    const bytes = utf8Bytes(`\n${line}`);
    if (used + bytes <= budgets.literals) {
      literalBlock += `\n${line}`;
      used += bytes;
      count++;
      add("exact values", LITERALS_HEADER, line);
    }
  }
  if (!count) literalBlock = "";
  const failures = sourceFailures(events);
  const failureGrant = budgets.historyBlocks["[Outstanding Context]"];
  const outstanding = failures.length && failureGrant !== undefined
    ? sourceHistoryBlock("[Outstanding Context]", failures, failureGrant) : "";
  // A missing allocation for a real failure is not an omission notice.
  if (failures.length && failureGrant === undefined) add("open failures", "[Outstanding Context]", "");
  else add("open failures", "[Outstanding Context]", outstanding, true);

  // Pair calls with results, then fold in result order: parallel calls need not
  // finish in the order in which they were issued.
  const calls = new Map(events.flatMap((event) => event.kind === "toolCall" ? [[event.toolCallId, event] as const] : []));
  const changes = events.flatMap((event) => {
    if (event.kind !== "toolResult") return [];
    const call = calls.get(event.toolCallId);
    return call && (call.name === "Edit" || call.name === "Write") ? [{ call, result: event }] : [];
  });
  let latest = qaLatestModification.init({});
  for (const { call, result } of changes) {
    latest = qaLatestModification.step({}, latest, { success: result.isError ? 0 : 1, callIndex: call.index });
  }
  const selected = changes[(latest.scalars.chosen ?? 0) - 1];
  if (changes.length) {
    const pathValue = selected?.call.args.file_path ?? selected?.call.args.path ?? selected?.call.args.dir;
    const path = typeof pathValue === "string" && pathValue.trim() ? ` ${pathValue}` : "";
    const line = selected ? clipUtf8(`Last change: ${selected.call.name}${path}`, MAX_RENDERED_LINE_BYTES) : "";
    const statusSource = sourceStatus(events, selected ? `Last change: ${selected.call.name}${path}` : "");
    const statusGrant = budgets.historyBlocks["[Current Status]"];
    const status = statusGrant === undefined ? "" : sourceHistoryBlock(statusSource.header, statusSource.lines, statusGrant);
    const omission = fallback(status);
    if (line && !status.split("\n").includes(line) && omission) add("last modification", "[Current Status]", omission);
    else probes.push({ reason: "last modification", section: "[Current Status]", expected: line, lastChange: true });
  }
  add("recall footer", "footer", "Recover full context in fabric_exec with history.recall and history.expand.");
  const prefix = [SUMMARY_HEADER, literalBlock, sourceCarry(literalSource.earlierSummary, budgets.carry)].filter(Boolean);
  const outerStart = prefix.join("\n\n").length + 2;
  const request = requestLines.length ? sourceProtected(REQUEST_HEADER, requestLines, MAX_REQUEST_SECTION_BYTES, "compaction request, not a transcript row") : "";
  const beforeHistory = [...prefix, goal.block, fullDialogue, request].filter(Boolean);
  const historyStart = beforeHistory.join("\n\n").length + 2;
  const files = sourceFiles(events);
  const filesGrant = budgets.historyBlocks["[Files And Changes]"];
  const fileBlock = files.length && filesGrant !== undefined ? sourceHistoryBlock("[Files And Changes]", files, filesGrant) : "";
  const outstandingStart = [...beforeHistory, fileBlock].filter(Boolean).join("\n\n").length + 2;
  const turns = sourceEarlierTurns(events);
  const turnGrant = budgets.historyBlocks["[Earlier Turns]"];
  const turnBlock = turns.length && turnGrant !== undefined ? sourceHistoryBlock("[Earlier Turns]", turns, turnGrant) : "";
  const statusStart = [...beforeHistory, fileBlock, outstanding, turnBlock].filter(Boolean).join("\n\n").length + 2;
  return { probes, outerStart, historyStart, outstandingStart, statusStart, literalLength: literalBlock.length, goalBlock: goal.block };
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
  let tally = qaTally.init({});
  // The literal block precedes every outer section. Recalculate only its framing
  // length so a removed literal cannot shift a later probe onto carried text.
  const literalStart = summary.startsWith(`${SUMMARY_HEADER}\n\n${LITERALS_HEADER}\n`) ? SUMMARY_HEADER.length : -1;
  const literalEnd = literalStart < 0 ? -1 : summary.indexOf("\n\n", literalStart + 2);
  const actualLiteralLength = literalStart < 0 ? 0 : (literalEnd < 0 ? summary.length : literalEnd) - literalStart - 2;
  const outerStart = Math.max(0, plan.outerStart + actualLiteralLength - plan.literalLength);
  for (const probe of plan.probes) {
    const adjustment = actualLiteralLength - plan.literalLength;
    const history = probe.section === "[Outstanding Context]" || probe.section === "[Current Status]";
    let sectionStart = history ? Math.max(0, (probe.section === "[Outstanding Context]" ? plan.outstandingStart : plan.statusStart) + adjustment) : outerStart;
    let section = "";
    if (history) {
      if (summary.startsWith(`${probe.section}\n`, sectionStart)) section = sectionOf(summary, probe.section, sectionStart, probe.expected);
    } else if (probe.section === DIALOGUE_HEADER && plan.goalBlock) {
      // Earlier user text can contain arbitrary section headings. Only the
      // end of its complete source-derived block locates the real dialogue.
      if (summary.startsWith(plan.goalBlock, outerStart)) {
        sectionStart = outerStart + plan.goalBlock.length + 2;
        section = sectionOf(summary, probe.section, sectionStart, probe.expected);
      }
    } else section = sectionOf(summary, probe.section, sectionStart, probe.expected);
    const matches = (value: string): boolean => {
      if (probe.lastChange) {
        const lines = value.split("\n").filter((line) => line.startsWith("Last change: "));
        return probe.expected ? lines.length === 1 && lines[0] === probe.expected : lines.length === 0;
      }
      return probe.exact ? value === probe.expected : !!probe.expected && value.includes(probe.expected);
    };
    const pass = matches(section);
    tally = qaTally.step({}, tally, { pass: pass ? 1 : 0, isFooter: probe.reason === "recall footer" ? 1 : 0 });
    // A damaged earlier block can move later sections. Searching in that case is
    // diagnostic only: it never turns a structurally failed probe into a pass.
    const diagnostic = history && !section
      ? matches(sectionOf(summary, probe.section, Math.max(0, plan.historyStart + adjustment), probe.expected))
      : pass;
    if (!diagnostic) failed.push(probe.reason);
  }
  const { required = 0, satisfied = 0, footer = 0 } = tally.scalars;
  const admitted = compactionQa.step({}, compactionQa.init({}), { required, satisfied, footer }).scalars["out.admitted"] === 1;
  if (admitted) return { required, satisfied };
  return { reason: failed.find((reason) => reason === "exact values") ?? failed[0] ?? "recall footer", required, satisfied };
};
