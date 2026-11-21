// Source-based reconstruction checks. History records are checked without
// trusting their renderer grants; literal demand has a narrower partial check.
import { DIALOGUE_HEADER, EARLIER_USERS_HEADER, MAX_DIALOGUE_SECTION_BYTES, MAX_EARLIER_USERS_SECTION_BYTES, MAX_RENDERED_LINE_BYTES, MAX_REQUEST_SECTION_BYTES, REQUEST_HEADER, allocateProtectedRoom, clipUtf8, protectedBudgets, boundedExcerpt, boundedHeadTail, boundedTailExcerpt, omissionLine, recentDialogueBytes, requestSectionBytes, utf8Bytes } from "./bounds.ts";
import { MAX_RECENT_EXCHANGES, type DialogueExchange } from "./dialogue.ts";
import type { CompactionEvent } from "./from-claude.ts";
import { LITERALS_HEADER, MAX_LITERALS_SECTION_BYTES } from "./literals.ts";
import { allocateSummaryCarry } from "./verified/context.ts";
import { MAX_SUMMARY_BYTES } from "./bounds.ts";
import { sourceLiterals, type LiteralSource } from "./qa-literals.ts";
import { MAX_EARLIER_USERS, MAX_USER_MESSAGE_BYTES } from "./projections.ts";
import { sourceFailures, sourceHistoryBlock, sourceStatus } from "./qa-history.ts";
import { ASSISTANT_CAVEAT, shortAssistantHeading, SUMMARY_HEADER, type RenderedSummary } from "./render.ts";
import { compactionQa, qaGrant, qaHistoryAccounting, qaLatestModification, qaTally } from "./verified/generated/compaction-qa.js";

export type QaReason = "original request" | "dialogue" | "exact values" | "open failures" | "last modification" | "recall footer";
interface Probe { reason: QaReason; section: string; expected: string; exact?: boolean; assertion?: boolean; }
interface HistoryProbe { reason: QaReason; header: string; lines: string[]; }
export interface QaPlan { probes: Probe[]; histories: HistoryProbe[]; literals: string[]; spans: RenderedSummary["qaBudgets"]["spans"]; }
type Budgets = RenderedSummary["qaBudgets"];

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

/** The source and cut are normalized and addressed by compact, before rendering. */
export const qaPlan = (events: CompactionEvent[], retained: CompactionEvent[],
  literalSource: LiteralSource, budgets: Budgets, requestLines: readonly string[] = []): QaPlan => {
  const probes: Probe[] = [];
  const add = (reason: QaReason, section: string, expected: string, exact = false): void => {
    probes.push({ reason, section, expected, ...(exact ? { exact: true } : {}) });
  };
  const window = sourceExchanges(events, retained);
  const exchanges = window.slice(-MAX_RECENT_EXCHANGES);
  const sourceRecentItems = sourceDialogue(exchanges).map(shortAssistantHeading);
  const sourceOlderItems = sourceOlderReplies(window);
  const sourceCaveat = [...sourceRecentItems, ...sourceOlderItems].some((item) => item.startsWith("Assistant response [entry ")) ? ASSISTANT_CAVEAT : "";
  const recentDemand = recentDialogueBytes(sourceCaveat ? [sourceCaveat, ...sourceRecentItems] : sourceRecentItems);
  const goalGrant = allocateProtectedRoom(recentDemand, requestSectionBytes(requestLines), MAX_EARLIER_USERS_SECTION_BYTES, 0).newestBytes;
  const goal = sourceGoal(events, exchanges, requestLines, goalGrant);
  const first = events.find((event) => event.kind === "user" && event.text.trim());
  if (first && !exchanges.some(({ user }) => user.entryId === first.entryId)) {
    const { header, items, selected } = goal;
    const index = selected.findIndex((user) => user.entryId === first.entryId);
    let expected = index < 0 ? "" : items[index]!;
    if (expected && utf8Bytes([header, ...items].join("\n\n")) > goalGrant) {
      if (utf8Bytes(header) + 2 * items.length > goalGrant) {
        expected = boundedExcerpt(items.join("\n\n"), goalGrant - utf8Bytes(header) - 2).text;
      } else {
        expected = boundedExcerpt(expected, protectedBudgets(header, items, goalGrant)[index]!).text;
      }
    }
    add("original request", EARLIER_USERS_HEADER, expected ? goal.block : "", true);
  }
  const recent = sourceRecentItems;
  let fullDialogue = "";
  if (recent.length) {
    const older = sourceOlderItems;
    const caveat = sourceCaveat;
    const header = caveat ? `${DIALOGUE_HEADER}\n\n${caveat}` : DIALOGUE_HEADER;
    const expected = sourceProtected(header, recent, MAX_DIALOGUE_SECTION_BYTES);
    const olderHeader = "Earlier assistant replies (unverified):";
    const replyRoom = allocateProtectedRoom(recentDemand, requestSectionBytes(requestLines), utf8Bytes(goal.block), MAX_DIALOGUE_SECTION_BYTES).carryBytes;
    const olderGrant = Math.min(MAX_DIALOGUE_SECTION_BYTES - utf8Bytes(expected), replyRoom) - 2;
    fullDialogue = older.length && olderGrant >= utf8Bytes(olderHeader) + 2
      ? `${expected}\n\n${sourceHistoryBlock(olderHeader, older, olderGrant)}` : expected;
    add(first && exchanges.some(({ user }) => user.entryId === first.entryId) ? "original request" : "dialogue", DIALOGUE_HEADER, fullDialogue, true);
    // A separate check retains the dialogue reason even if the first request is recent.
    if (first && exchanges.some(({ user }) => user.entryId === first.entryId)) add("dialogue", DIALOGUE_HEADER, fullDialogue, true);
  }
  if (!recent.length) add("dialogue", DIALOGUE_HEADER, "", true);
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
  let demand = utf8Bytes(framing);
  let hasDemand = false;
  for (const value of values) {
    const bytes = utf8Bytes(`\n- [entry ${value.entryId}] ${value.value}`);
    if (allocateSummaryCarry(MAX_LITERALS_SECTION_BYTES, 0, demand + bytes, 0, 0).newestBytes === demand + bytes) {
      demand += bytes;
      hasDemand = true;
    }
  }
  if (!hasDemand) demand = 0;
  const request = requestLines.length ? sourceProtected(REQUEST_HEADER, requestLines, MAX_REQUEST_SECTION_BYTES, "compaction request, not a transcript row") : "";
  const newest = [goal.block, fullDialogue, request].filter(Boolean);
  const carried = literalSource.earlierSummary;
  const carryBody = carried.startsWith(`${LITERALS_HEADER}\n`) && carried.indexOf("\n\n") >= 0
    ? carried.slice(carried.indexOf("\n\n") + 2) : carried;
  const carryDemand = carried ? utf8Bytes(`[Earlier summary]\n${ASSISTANT_CAVEAT}`) + 2 + utf8Bytes(carryBody) : 0;
  // Partial literal-demand check: history sizes and minima come from the renderer.
  // It catches some dropped selections, but is not independent of history demand.
  const blockCount = 2 + newest.length + Number(!!carried) + Number(demand > 0) + budgets.historyFacts.length;
  const framingBytes = utf8Bytes(SUMMARY_HEADER) + budgets.footerBytes + 2 * (blockCount - 1) + 1;
  const otherDemand = budgets.historyFacts.reduce((sum, fact) => sum + fact.bytes, 0);
  const allocation = allocateSummaryCarry(MAX_SUMMARY_BYTES, framingBytes, newest.reduce((sum, block) => sum + utf8Bytes(block), 0), carryDemand, otherDemand + demand);
  const minimum = Math.min(allocation.historyBytes, budgets.historyFacts.reduce((sum, fact) => sum + fact.minimum, 0));
  const owed = allocateSummaryCarry(allocation.historyBytes - minimum, 0, demand, 0, 0).newestBytes;
  let used = utf8Bytes(framing);
  for (const value of values) {
    const line = `- [entry ${value.entryId}] ${value.value}`;
    const bytes = utf8Bytes(`\n${line}`);
    if (allocateSummaryCarry(owed, 0, used + bytes, 0, 0).newestBytes === used + bytes) {
      used += bytes;
      add("exact values", LITERALS_HEADER, line);
    }
  }
  probes.push({ reason: "exact values", section: LITERALS_HEADER, expected: "", assertion: qaGrant.step({}, qaGrant.init({}), { owed, offered: budgets.literals }).scalars["out.adequate"] === 1 });
  if (!demand) add("exact values", LITERALS_HEADER, "", true);
  const failures = sourceFailures(events);

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
  const pathValue = selected?.call.args.file_path ?? selected?.call.args.path ?? selected?.call.args.dir;
  const path = typeof pathValue === "string" && pathValue.trim() ? ` ${pathValue}` : "";
  const statusSource = sourceStatus(events, selected ? `Last change: ${selected.call.name}${path}` : "");
  const histories: HistoryProbe[] = [
    { reason: "open failures", header: "[Outstanding Context]", lines: failures },
    { reason: "last modification", header: statusSource.header, lines: statusSource.lines },
  ];
  add("recall footer", "footer", "Recover full context in fabric_exec with history.recall and history.expand.");
  return { probes, histories, literals: values.map(({ entryId, value }) => `- [entry ${entryId}] ${value}`), spans: budgets.spans };
};

// Spans are emitted as the renderer joins its blocks. Validate their entire
// ordered partition before trusting one: a heading quoted inside source text
// is not an outer section, and gaps or overlaps cannot hide that text.
const ORDER = ["summary", LITERALS_HEADER, "[Earlier summary]", EARLIER_USERS_HEADER, DIALOGUE_HEADER,
  "[Compaction Request]", "[Files And Changes]", "[Outstanding Context]", "[Earlier Turns]", "[Current Status]", "transcript", "footer"];
const spanReason = (name: string): QaReason => name === LITERALS_HEADER ? "exact values"
  : name === EARLIER_USERS_HEADER ? "original request" : name === DIALOGUE_HEADER ? "dialogue"
  : name === "[Outstanding Context]" ? "open failures" : name === "[Current Status]" ? "last modification" : "recall footer";

const badSpan = (summary: string, spans: QaPlan["spans"]): QaReason | undefined => {
  let end = -2, order = -1;
  for (const span of spans) {
    const next = ORDER.indexOf(span.name);
    const header = span.name === "summary" ? SUMMARY_HEADER : span.name === "footer" || span.name === "transcript" ? "---" : span.name;
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || next <= order || span.start !== end + 2 ||
        span.end <= span.start || span.end > summary.length || !summary.startsWith(header, span.start) ||
        (summary[span.start + header.length] !== "\n" && span.name !== "summary") ||
        (span.name !== "footer" && summary.slice(span.end, span.end + 2) !== "\n\n") ||
        (span.name === "footer" && summary.slice(span.end) !== "\n")) return spanReason(span.name);
    end = span.end;
    order = next;
  }
  return spans[0]?.name === "summary" && spans.at(-1)?.name === "footer" ? undefined : "recall footer";
};

// Match whole bounded records, even when a path contains newlines or a heading.
// The renderer's omission marker counts source-projected lines, not raw events.
const historyMatches = (section: string, probe: HistoryProbe): boolean => {
  const lines = probe.lines.map((line) => clipUtf8(line, MAX_RENDERED_LINE_BYTES));
  if (!section) return qaHistoryAccounting.step({}, qaHistoryAccounting.init({}), { shown: 0, omitted: 0, total: lines.length }).scalars["out.admitted"] === 1;
  if (section !== probe.header && !section.startsWith(`${probe.header}\n`)) return false;
  const body = section.slice(probe.header.length + 1);
  const seen = new Set<string>();
  const visit = (offset: number, from: number, shown: number, omitted: number, marker: boolean): boolean => {
    if (offset === body.length) return qaHistoryAccounting.step({}, qaHistoryAccounting.init({}), { shown, omitted, total: lines.length }).scalars["out.admitted"] === 1;
    const key = `${offset}/${from}/${shown}/${omitted}/${marker}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const nextOffset = (text: string): number => {
      if (!body.startsWith(text, offset)) return -1;
      const end = offset + text.length;
      return end === body.length ? end : body[end] === "\n" ? end + 1 : -1;
    };
    for (let index = from; index < lines.length; index++) {
      const line = lines[index]!;
      const next = nextOffset(line);
      if (next >= 0 && visit(next, index + 1, shown + 1, omitted, marker)) return true;
    }
    if (!marker) {
      const match = /^… omitted ([1-9]\d*) rendered lines(?=\n|$)/.exec(body.slice(offset));
      if (match) {
        const count = Number(match[1]);
        const next = nextOffset(match[0]);
        if (Number.isSafeInteger(count) && count <= lines.length && next >= 0 && visit(next, from, shown, count, true)) return true;
      }
    }
    return false;
  };
  return visit(0, 0, 0, 0, false);
};

const literalsSound = (section: string, source: readonly string[]): boolean => {
  if (!section) return true;
  const prefix = `${LITERALS_HEADER}\nUnverified excerpts. Source ids; Recall expansion is best-effort.\n`;
  if (!section.startsWith(prefix)) return false;
  const values = section.slice(prefix.length).split("\n");
  const allowed = new Set(source);
  return values.length > 0 && values.every((value, index) => allowed.has(value) && values.indexOf(value) === index);
};

export const checkQa = (summary: string, plan: QaPlan): { reason?: QaReason; required: number; satisfied: number } => {
  const failed: QaReason[] = [];
  let tally = qaTally.init({});
  const broken = badSpan(summary, plan.spans);
  tally = qaTally.step({}, tally, { pass: broken ? 0 : 1, isFooter: 0 });
  if (broken) failed.push(broken);
  for (const probe of plan.probes) {
    const span = plan.spans.find((item) => item.name === probe.section);
    const section = span ? summary.slice(span.start, span.end) : "";
    let pass: boolean;
    if (probe.assertion !== undefined) pass = probe.assertion;
    else if (probe.exact) pass = section === probe.expected;
    else if (probe.reason === "exact values") pass = section.split("\n").filter((line) => line === probe.expected).length === 1;
    else pass = !!probe.expected && section.split("\n").filter((line) => line === probe.expected).length === 1;
    tally = qaTally.step({}, tally, { pass: pass ? 1 : 0, isFooter: probe.reason === "recall footer" ? 1 : 0 });
    if (!pass) failed.push(probe.reason);
  }
  const section = (name: string): string => {
    const span = plan.spans.find((item) => item.name === name);
    return span ? summary.slice(span.start, span.end) : "";
  };
  const sound = literalsSound(section(LITERALS_HEADER), plan.literals);
  tally = qaTally.step({}, tally, { pass: sound ? 1 : 0, isFooter: 0 });
  if (!sound) failed.push("exact values");
  for (const history of plan.histories) {
    const pass = historyMatches(section(history.header.split("\n")[0]!), history);
    tally = qaTally.step({}, tally, { pass: pass ? 1 : 0, isFooter: 0 });
    if (!pass) failed.push(history.reason);
  }
  const { required = 0, satisfied = 0, footer = 0 } = tally.scalars;
  const admitted = compactionQa.step({}, compactionQa.init({}), { required, satisfied, footer }).scalars["out.admitted"] === 1;
  if (admitted) return { required, satisfied };
  return { reason: failed.find((reason) => reason === "exact values") ?? failed[0] ?? "recall footer", required, satisfied };
};
