// Copied from pi-fabric (MIT, Tom X Nguyen) src/compaction/projections.ts at d331f629; dropped custom messages, Fabric run/phase/operation events and their activity fold, Pi's pi.* ref forms and the fresh-entry option, and reads Claude Code tool names and fields.
import { allocateProtectedRoom, boundedExcerpt, clipUtf8, EARLIER_USERS_HEADER, MAX_EARLIER_USERS_SECTION_BYTES, MAX_RENDERED_LINE_BYTES, omissionLine,
  protectedBudgets, recentDialogueBytes, requestSectionBytes, sampleAddressed, sampleAddressedFrom, utf8Bytes } from "./bounds.ts";
import { foldFailureLedger } from "./verified/context.ts";
import { checkUserSelection, type UserSelectionGate } from "./verified/policy.ts";
import { earlierAssistantReplies, projectDialogue, recentDialogue } from "./dialogue.ts";
import { firstLine, MAX_TRANSCRIPT_CMD, summarizeToolArgs, type CompactionEvent, type ToolCallEvent } from "./from-claude.ts";

// Section folds: each projection is a pure function of the typed event stream.
// Together they implement graded decay (principle 4): the oldest turns
// collapse to one line, recent events stay as a collapsed transcript with
// stable `[entry <handle>]` references, and the very last action is surfaced in Current
// Status. Salience (principle 3) is *computed* from the event stream by the
// outstanding fold's state machine — nothing is remembered, only re-derived.

export interface Sections {
  dialogue: string[];
  earlierAssistantReplies: string[];
  // Retain the internal key for v2 details compatibility; these are historical.
  goal: string[];
  files: string[];
  outstanding: string[];
  earlierTurns: string[];
  status: string[];
  transcript: string[];
}

const MAX_LINE = 140;
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "Grep", "Glob"]);
const MODIFYING_TOOLS = new Set(["Edit", "Write"]);
const MAX_EARLIER_USER = 80;
const MAX_STATUS_LINE = 140;
const MAX_TRANSCRIPT_LINE = 100;
// Every earlier user message renders verbatim while it fits. Above the count
// bound, reserve the opening and prefer newest distinct messages, then repeats.
export const MAX_EARLIER_USERS = 64;
export const MAX_USER_MESSAGE_BYTES = 4096;
export const MAX_FILES_PER_KIND = 24;
export const MAX_UNRESOLVED = 24;
export const MAX_EARLIER_TURNS = 32;
const TRANSCRIPT_WINDOW = 40;

export interface ProjectionOmittedCounts {
  goal: number;
  dialogueBytes?: number;
  files: number;
  outstanding: number;
  earlierTurns: number;
  transcript: number;
}

export interface ProjectionResult {
  sections: Sections;
  omittedCounts: ProjectionOmittedCounts;
  userSelection: { gate: UserSelectionGate; marker: string };
}

interface ProjectedSection {
  lines: string[];
  omitted: number;
}

const truncate = (text: string, max: number, verbatim = false): string => {
  const flat = verbatim ? text.trim() : text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const quoted = (text: string, max: number): string => JSON.stringify(truncate(text, max));

const pathOf = (args: Record<string, unknown>): string | undefined => {
  const value = args.file_path ?? args.path ?? args.dir;
  return typeof value === "string" && value.trim() ? value : undefined;
};

interface StructuralOperation {
  index: number;
  entryId: string;
  address: string;
  tool: string;
  ref: string;
  args: Record<string, unknown>;
  outcome: "succeeded" | "failed";
  error?: string;
  result?: unknown;
}

const collectOperations = (events: CompactionEvent[]): StructuralOperation[] => {
  const calls = new Map<string, ToolCallEvent>();
  for (const event of events) {
    if (event.kind === "toolCall") calls.set(event.toolCallId, event);
  }
  const operations: StructuralOperation[] = [];
  for (const event of events) {
    if (event.kind === "toolResult" && event.toolName !== "Bash") {
      const call = event.toolCallId ? calls.get(event.toolCallId) : undefined;
      if (!call) continue;
      operations.push({
        index: event.index,
        entryId: call.entryId,
        address: event.isError && event.text ? event.entryId : call.entryId,
        tool: call.name,
        ref: call.name,
        args: call.args,
        outcome: event.isError ? "failed" : "succeeded",
        ...(event.isError && event.text ? { error: event.text } : {}),
      });
      continue;
    }
    if (event.kind === "bash") {
      operations.push({
        index: event.index,
        entryId: event.entryId,
        address: event.entryId,
        tool: "Bash",
        ref: "Bash",
        args: { command: event.command },
        outcome: event.isError ? "failed" : "succeeded",
        ...(event.error ? { error: event.error } : {}),
      });
    }
  }
  return operations.sort((left, right) => left.index - right.index);
};

const isFileOperation = (operation: StructuralOperation): boolean =>
  FILE_TOOLS.has(operation.tool) && operation.ref === operation.tool;

const isBashOperation = (operation: StructuralOperation): boolean =>
  operation.tool === "Bash" && operation.ref === "Bash";

const resultProvesCreation = (result: unknown): boolean => {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const record = result as Record<string, unknown>;
  if (record.created === true) return true;
  const details = record.details;
  return Boolean(details && typeof details === "object" && !Array.isArray(details)
    && (details as Record<string, unknown>).created === true);
};

// Longest common path prefix (by segment) across a set of paths, returned with
// a trailing separator. Returns "" when there is none.
const commonRoot = (paths: string[]): string => {
  if (paths.length === 0) return "";
  const split = paths.map((p) => p.split(/[\\/]/).filter(Boolean));
  let common = 0;
  const first = split[0]!;
  loop: while (common < first.length) {
    const segment = first[common];
    for (let i = 1; i < split.length; i++) {
      if (split[i]!.length <= common || split[i]![common] !== segment) break loop;
    }
    common += 1;
  }
  if (common === 0) return "";
  return `${first.slice(0, common).join("/")}/`;
};

const stripRoot = (root: string, path: string): string =>
  root ? path.replace(root, "") : path;

const earlierUserHeading = (entryId: string): string => `User [entry ${entryId}]:\n`;

/** One earlier user message as the summary renders it: verbatim up to a byte bound. */
export const earlierUserItem = (user: { entryId: string; text: string }, maxBytes = MAX_USER_MESSAGE_BYTES): string =>
  `${earlierUserHeading(user.entryId)}${boundedExcerpt(user.text, Math.min(maxBytes, MAX_USER_MESSAGE_BYTES), user.entryId).text}`;

// Earlier user messages are the user's own words, kept verbatim and in order.
// They are evidence of what was asked, not an inferred active mandate.
const projectGoal = (events: CompactionEvent[], protectedUsers: ReadonlySet<string>, maxBytes: number): ProjectedSection & { gate: UserSelectionGate; marker: string } => {
  const users = events.flatMap((event) => event.kind === "user" && !protectedUsers.has(event.entryId) && event.text.trim()
    ? [{ event }] : []);
  const last = new Map(users.map(({ event }, index) => [event.text, index]));
  const ranked = users.map((user, index) => ({ ...user, index, distinct: last.get(user.event.text) === index }));
  ranked.sort((a, b) => Number(b.distinct) - Number(a.distinct) || b.index - a.index);
  const chosen = users.length > MAX_EARLIER_USERS
    ? [0, ...ranked.filter(({ index }) => index !== 0).slice(0, MAX_EARLIER_USERS - 1).map(({ index }) => index)]
    : ranked.map(({ index }) => index);
  const kept = new Set(chosen);
  const gate = checkUserSelection(users.map(({ event }) => event.text), kept);
  const omitted = users.filter((_, index) => !kept.has(index));
  // Omitted entries can be interleaved with kept ones, so the endpoints name
  // the range containing omissions, not a claim that every entry in it was lost.
  const marker = gate.noticeRequired ? `${omissionLine(gate.omitted, omitted[0]?.event.entryId, omitted.at(-1)?.event.entryId, "user messages")} (not necessarily consecutive); later directives may be omitted` : "";
  const selected = users.filter((_, index) => kept.has(index));
  const items = selected.map(({ event }) => earlierUserItem(event));
  const header = marker ? `${EARLIER_USERS_HEADER}\n${marker}` : EARLIER_USERS_HEADER;
  // Short items keep their full share; any surplus goes to newer long items.
  if (utf8Bytes([header, ...items].join("\n\n")) > maxBytes) {
    const budgets = protectedBudgets(header, [...items].reverse(), maxBytes).reverse();
    selected.forEach(({ event }, index) => {
      if (utf8Bytes(items[index]!) <= budgets[index]!) return;
      const bodyBytes = Math.max(0, budgets[index]! - utf8Bytes(earlierUserHeading(event.entryId)));
      items[index] = earlierUserItem(event, bodyBytes);
    });
  }
  return { lines: marker ? [marker, ...items] : items, omitted: gate.omitted, gate, marker };
};

// [Files And Changes] uses only successful structural operations. Writes are
// labelled Written unless a typed result explicitly proves creation.
interface FileAddress {
  path: string;
  entryId: string;
}

const projectFiles = (events: CompactionEvent[]): ProjectedSection => {
  const read = new Map<string, FileAddress>();
  const modified = new Map<string, FileAddress>();
  const written = new Map<string, FileAddress>();
  const created = new Map<string, FileAddress>();

  for (const operation of collectOperations(events)) {
    if (!isFileOperation(operation) || operation.outcome !== "succeeded") continue;
    const path = pathOf(operation.args);
    if (!path) continue;
    const address = { path, entryId: operation.address };
    if (operation.tool === "Write") {
      const target = resultProvesCreation(operation.result) ? created : written;
      if (!target.has(path)) target.set(path, address);
    } else if (operation.tool === "Edit") {
      if (!modified.has(path)) modified.set(path, address);
    } else if (!read.has(path)) {
      read.set(path, address);
    }
  }

  const modifiedSet = new Set<string>();
  for (const path of modified.keys()) modifiedSet.add(path);
  for (const path of written.keys()) modifiedSet.add(path);
  for (const path of created.keys()) modifiedSet.add(path);
  function* filteredRead(): Generator<FileAddress> {
    for (const item of read.values()) {
      if (!modifiedSet.has(item.path)) yield item;
    }
  }
  const sampledCreated = sampleAddressedFrom(created.values(), MAX_FILES_PER_KIND);
  const sampledWritten = sampleAddressedFrom(written.values(), MAX_FILES_PER_KIND);
  const sampledModified = sampleAddressedFrom(modified.values(), MAX_FILES_PER_KIND);
  const sampledRead = sampleAddressedFrom(filteredRead(), MAX_FILES_PER_KIND);
  const allSampled = [
    ...sampledCreated.values,
    ...sampledWritten.values,
    ...sampledModified.values,
    ...sampledRead.values,
  ];
  if (allSampled.length === 0) return { lines: [], omitted: 0 };
  const root = commonRoot(allSampled.map((item) => item.path));
  const lines: string[] = [];
  let omitted = 0;
  if (root) lines.push(`(under ${root})`);

  const appendKind = (
    header: string,
    sampled: ReturnType<typeof sampleAddressed<FileAddress>>,
  ): void => {
    if (sampled.values.length === 0 && sampled.omitted === 0) return;
    lines.push(header);
    omitted += sampled.omitted;
    for (let index = 0; index < sampled.values.length; index++) {
      if (sampled.omitted > 0 && index === sampled.splitIndex) {
        lines.push(`  ${omissionLine(
          sampled.omitted,
          sampled.omittedFirstEntryId,
          sampled.omittedLastEntryId,
          "file addresses",
        )}`);
      }
      const item = sampled.values[index]!;
      lines.push(`  ${stripRoot(root, item.path)} [entry ${item.entryId}]`);
    }
  };

  appendKind("Created:", sampledCreated);
  appendKind("Written:", sampledWritten);
  appendKind("Modified:", sampledModified);
  appendKind("Read:", sampledRead);
  return { lines, omitted };
};

interface ErrorItem {
  index: number;
  entryId: string;
  description: string;
  resolved: boolean;
}

const rangeLine = (count: number, items: readonly ErrorItem[], noun: string): string =>
  omissionLine(count, items[0]?.entryId, items.at(-1)?.entryId, noun);

// [Outstanding Context] is keyed only by typed operation identity. A later
// success resolves a failure only when action+path, action+command, or the
// generic ref+arguments identity is exactly equal. The verified failure ledger
// accounts for every failure once: open failures are itemized newest first;
// the rest and resolved ones become counts.
const projectOutstandingWithMetadata = (events: CompactionEvent[]): ProjectedSection => {
  const operations = collectOperations(events);
  const keyOf = (operation: StructuralOperation): string => {
    const path = isFileOperation(operation) ? pathOf(operation.args) : undefined;
    if (path) return `file\0${operation.tool}\0${path}`;
    const command = isBashOperation(operation) && typeof operation.args.command === "string"
      ? operation.args.command
      : undefined;
    if (command !== undefined) return `bash\0${operation.tool}\0${command}`;
    return `generic\0${operation.ref}\0${JSON.stringify(operation.args)}`;
  };
  // Latest success index per identity: a failure resolves when one follows it.
  const lastSuccess = new Map<string, number>();
  for (const operation of operations) {
    if (operation.outcome === "succeeded") lastSuccess.set(keyOf(operation), operation.index);
  }
  const items: ErrorItem[] = [];

  for (const operation of operations) {
    if (operation.outcome === "succeeded") continue;
    const path = isFileOperation(operation) ? pathOf(operation.args) : undefined;
    const command = isBashOperation(operation) && typeof operation.args.command === "string"
      ? operation.args.command
      : undefined;
    const subject = path
      ? `${operation.ref} ${path}`
      : command !== undefined
        ? `${operation.ref}: ${truncate(firstLine(command), MAX_LINE)}`
        : operation.ref;
    const error = operation.error ? `: ${truncate(firstLine(operation.error), MAX_LINE, true)}` : `: ${operation.outcome}`;
    items.push({
      index: operation.index,
      entryId: operation.address,
      description: `${subject}${error}`,
      resolved: (lastSuccess.get(keyOf(operation)) ?? -1) > operation.index,
    });
  }

  if (items.length === 0) return { lines: [], omitted: 0 };
  const newestFirst = [...items].sort((a, b) => b.index - a.index);
  const rank = (item: ErrorItem): number => (item.resolved ? 1 : 0);
  const ordered = [...newestFirst].sort((a, b) => rank(a) - rank(b));
  const ledger = foldFailureLedger(ordered.map((item) => ({ fresh: true, resolved: item.resolved })), MAX_UNRESOLVED);
  const itemized: ErrorItem[] = [];
  const openOlder: ErrorItem[] = [];
  const resolved: ErrorItem[] = [];
  ordered.forEach((item, position) => {
    if (ledger.itemized[position]) itemized.push(item);
    else if (item.resolved) resolved.push(item);
    else openOlder.push(item);
  });
  for (const list of [itemized, openOlder, resolved]) list.sort((a, b) => a.index - b.index);

  const lines: string[] = [];
  if (openOlder.length > 0) lines.push(rangeLine(openOlder.length, openOlder, "older open error records"));
  for (const item of itemized) lines.push(`- ${item.description} [entry ${item.entryId}]`);
  if (resolved.length > 0) {
    lines.push(rangeLine(resolved.length, resolved, "error records later resolved by an exact retry"));
  }
  return { lines, omitted: ledger.total - itemized.length };
};

export const projectOutstanding = (events: CompactionEvent[]): string[] =>
  projectOutstandingWithMetadata(events).lines;

interface EarlierTurnAddress {
  entryId: string;
  contextLine: string;
  tools: string;
}

// [Earlier Turns] — sampled one-liners for turns before the latest summarized
// one (which Current Status surfaces), plus tool-name histograms and an
// entry-range address for any omitted middle turns.
const projectEarlierTurns = (events: CompactionEvent[]): ProjectedSection => {
  function* earlierTurns(): Generator<EarlierTurnAddress> {
    let currentContext: Extract<CompactionEvent, { kind: "user" }> | undefined;
    let counts = new Map<string, number>();
    let order: string[] = [];
    const completed = (): EarlierTurnAddress | undefined => {
      if (!currentContext) return undefined;
      return {
        entryId: currentContext.entryId,
        contextLine: quoted(firstLine(currentContext.text), MAX_EARLIER_USER),
        tools: order.map((name) => `${name}:${counts.get(name) ?? 0}`).join(" "),
      };
    };
    for (const event of events) {
      if (event.kind === "user") {
        const turn = completed();
        if (turn) yield turn;
        currentContext = event;
        counts = new Map<string, number>();
        order = [];
        continue;
      }
      if (!currentContext) continue;
      const name = event.kind === "toolCall" ? event.name : event.kind === "bash" ? "Bash" : undefined;
      if (!name) continue;
      if (!counts.has(name)) order.push(name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  const sampled = sampleAddressedFrom(earlierTurns(), MAX_EARLIER_TURNS);
  const lines: string[] = [];
  for (let index = 0; index < sampled.values.length; index++) {
    if (sampled.omitted > 0 && index === sampled.splitIndex) {
      lines.push(omissionLine(
        sampled.omitted,
        sampled.omittedFirstEntryId,
        sampled.omittedLastEntryId,
        "earlier turns",
      ));
    }
    const turn = sampled.values[index]!;
    lines.push(`${turn.contextLine}${turn.tools ? ` | ${turn.tools}` : ""} [entry ${turn.entryId}]`);
  }
  return { lines, omitted: sampled.omitted };
};

// [Current Status] — a bridge from the summarized window into the kept tail:
// the last summarized user request, the last successful file-modifying tool
// call, and the last assistant line. A failed Edit or Write is an attempt, not
// a change; it is reported by [Outstanding Context], never as the last change.
// Only non-empty fields are emitted.
const projectStatus = (events: CompactionEvent[]): string[] => {
  const lastUser = [...events].reverse().find(
    (event): event is Extract<CompactionEvent, { kind: "user" }> => event.kind === "user",
  );
  const lines: string[] = [];
  if (lastUser) {
    lines.push(`Last request: ${truncate(firstLine(lastUser.text), MAX_STATUS_LINE)} [entry ${lastUser.entryId}]`);
  }
  let lastModify: { tool: string; args: Record<string, unknown> } | undefined;
  for (const operation of collectOperations(events)) {
    if (isFileOperation(operation) && MODIFYING_TOOLS.has(operation.tool) && operation.outcome === "succeeded") {
      lastModify = operation;
    }
  }
  if (lastModify) {
    const path = pathOf(lastModify.args) ?? "";
    lines.push(`Last change: ${lastModify.tool}${path ? ` ${path}` : ""}`);
  }
  const lastAssistant = [...events]
    .reverse()
    .find((e): e is Extract<CompactionEvent, { kind: "assistantText" }> => e.kind === "assistantText");
  if (lastAssistant) {
    const text = truncate(firstLine(lastAssistant.text), MAX_STATUS_LINE);
    if (text) lines.push(`Last note: ${text}`);
  }
  return lines;
};

// Count source characters (Unicode code points), including line breaks and whitespace
// removed when the first line is flattened. Give the marker room inside the line cap.
const transcriptLine = (prefix: string, text: string, verbatim = false): string => {
  const first = verbatim ? firstLine(text).trimEnd() : firstLine(text).replace(/\s+/g, " ").trim();
  const chars = Array.from(first);
  let keep = chars.length > MAX_TRANSCRIPT_LINE ? MAX_TRANSCRIPT_LINE - 1 : chars.length;
  let total = 0, extraLines = 0;
  for (const char of text) {
    total++;
    if (char === "\n") extraLines++;
  }
  const candidate = (): string => {
    const preview = chars.slice(0, keep).join("") + (keep < chars.length ? "…" : "");
    const omitted = total - keep;
    if (!omitted) return prefix + preview;
    const lines = extraLines ? `${extraLines} ${extraLines === 1 ? "line" : "lines"}, ` : "";
    return `${prefix}${preview} [${lines}${omitted} ${omitted === 1 ? "char" : "chars"} cut; history.expand]`;
  };
  let line = candidate();
  while (utf8Bytes(line) > MAX_RENDERED_LINE_BYTES && keep > 0) {
    keep--;
    line = candidate();
  }
  if (utf8Bytes(line) > MAX_RENDERED_LINE_BYTES) throw new Error("fabric: transcript handle leaves no room for its omission marker");
  return line;
};

// Brief transcript — the "collapsed transcript" tier of graded decay. A
// rolling window of the last 40 events rendered as one-liners, each prefixed
// with its stable `(#N)` reference so the agent can point back at a specific
// event without storing its content (principle 0).
const projectTranscript = (events: CompactionEvent[]): ProjectedSection => {
  const window = events.slice(-TRANSCRIPT_WINDOW);
  const lines: string[] = [];
  const omitted = events.length - window.length;
  if (omitted > 0) {
    lines.push(omissionLine(
      omitted,
      events[0]?.entryId,
      events[omitted - 1]?.entryId,
      "transcript events",
    ));
  }
  for (const e of window) {
    const ref = `[entry ${e.entryId}]`;
    if (e.kind === "user") {
      lines.push(transcriptLine(`${ref} user: `, e.text));
    } else if (e.kind === "assistantText") {
      lines.push(transcriptLine(`${ref} assistant: `, e.text));
    } else if (e.kind === "toolCall") {
      lines.push(`${ref} ${e.name}(${summarizeToolArgs(e.name, e.args)})`);
    } else if (e.kind === "toolResult") {
      const status = e.isError ? "error" : "ok";
      lines.push(transcriptLine(`${ref} → ${status}: `, e.text, true));
    } else if (e.kind === "bash") {
      const status = e.isError ? "error" : "ok";
      lines.push(`${ref} Bash(${truncate(firstLine(e.command), MAX_TRANSCRIPT_CMD)}) → ${status}`);
    }
  }
  return { lines, omitted };
};

export const projectWithMetadata = (
  events: CompactionEvent[],
  retainedDialogue: CompactionEvent[] = [],
  requestLines: readonly string[] = [],
): ProjectionResult => {
  const exchanges = recentDialogue(events, retainedDialogue);
  const dialogue = projectDialogue(exchanges);
  const userBudget = allocateProtectedRoom(recentDialogueBytes(dialogue.lines), requestSectionBytes(requestLines), MAX_EARLIER_USERS_SECTION_BYTES, 0).newestBytes;
  const goal = projectGoal(events, new Set(exchanges.map(({ user }) => user.entryId)), userBudget);
  const files = projectFiles(events);
  const outstanding = projectOutstandingWithMetadata(events);
  const earlierTurns = projectEarlierTurns(events);
  const transcript = projectTranscript(events);
  return {
    sections: {
      dialogue: dialogue.lines,
      earlierAssistantReplies: earlierAssistantReplies(events, retainedDialogue),
      goal: goal.lines,
      files: files.lines,
      outstanding: outstanding.lines,
      earlierTurns: earlierTurns.lines,
      status: projectStatus(events),
      transcript: transcript.lines,
    },
    userSelection: { gate: goal.gate, marker: goal.marker },
    omittedCounts: {
      goal: goal.omitted,
      dialogueBytes: dialogue.omittedBytes,
      files: files.omitted,
      outstanding: outstanding.omitted,
      earlierTurns: earlierTurns.omitted,
      transcript: transcript.omitted,
    },
  };
};

export const project = (events: CompactionEvent[]): Sections =>
  projectWithMetadata(events).sections;
