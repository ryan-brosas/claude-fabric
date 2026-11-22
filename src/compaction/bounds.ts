// Copied from pi-fabric (MIT, Tom X Nguyen) src/compaction/bounds.ts at d331f629; dropped canonicalizeText, which only the typed compaction requests used.
import { allocateSummaryCarry } from "./verified/context.ts";
import { acceptAddressedSample, acceptBoundedText, byteCap, checkedProtectedTotal, checkedSamplePosition, protectedItemBytes, protectedRoom, sectionBytes, textPlan } from "./verified/bounds.ts";

export const MAX_SUMMARY_BYTES = 32 * 1024;
export const MAX_RENDERED_LINE_BYTES = 1024;
export const EARLIER_USERS_HEADER = "[Earlier user messages]";
export const MAX_EARLIER_USERS_SECTION_BYTES = 22528;
export const DIALOGUE_HEADER = "[Recent user directions and discussion]";
export const MAX_DIALOGUE_SECTION_BYTES = 12288;
export const REQUEST_HEADER = "[Compaction Request]";
export const MAX_REQUEST_SECTION_BYTES = 3072;
export const MAX_SUMMARY_FOOTER_BYTES = 1536;
// The extra 256 bytes hold the summary header, separators and final newline.
export const MAX_SUMMARY_FRAMING_BYTES = MAX_SUMMARY_FOOTER_BYTES + 256;

/** Reserve framing, the request and recent dialogue, then give users room before old replies.
 * This is the same checked allocation as the summary, with no history demand. */
export const allocateProtectedRoom = (recentBytes: number, requestBytes: number, userDemand: number, replyDemand: number) =>
  allocateSummaryCarry(MAX_SUMMARY_BYTES, MAX_SUMMARY_FRAMING_BYTES + byteCap(requestBytes) + byteCap(recentBytes),
    byteCap(userDemand), byteCap(replyDemand), 0);

export const recentDialogueBytes = (items: readonly string[]): number =>
  sectionBytes(items.length === 0 ? 0 : utf8Bytes([DIALOGUE_HEADER, ...items].join("\n\n")), MAX_DIALOGUE_SECTION_BYTES);

export const requestSectionBytes = (items: readonly string[]): number =>
  sectionBytes(items.length === 0 ? 0 : utf8Bytes([REQUEST_HEADER, ...items].join("\n\n")), MAX_REQUEST_SECTION_BYTES);

const encoder = new TextEncoder();

export const utf8Bytes = (text: string): number => encoder.encode(text).byteLength;

// Commit only text whose measured output and source loss the machine accepts.
// `markerCount` is supplied only for omission markers, never a clipping suffix.
const checkedText = (source: string, maxBytes: number, head: string, marker: string, tail: string,
  omitted: number, markerCount?: number): { text: string; omittedBytes: number } => {
  const text = `${head}${marker}${tail}`;
  const sourceBytes = utf8Bytes(source);
  const facts = { source: sourceBytes, cap: Math.min(byteCap(maxBytes), sourceBytes), head: utf8Bytes(head), tail: utf8Bytes(tail),
    marker: utf8Bytes(marker), omitted, markerCount: markerCount ?? 0, output: utf8Bytes(text),
    unchanged: text === source, marked: markerCount !== undefined };
  if (!acceptBoundedText(facts)) throw new Error("fabric: bounded text failed its verified check");
  return { text, omittedBytes: omitted };
};

export const clipUtf8 = (text: string, maxBytes: number, suffix = "…"): string => {
  const source = utf8Bytes(text), cap = byteCap(maxBytes);
  if (cap === 0) return checkedText(text, cap, "", "", "", source).text;
  if (source <= cap) return checkedText(text, cap, text, "", "", 0).text;
  const suffixBytes = utf8Bytes(suffix);
  if (suffixBytes >= cap) return checkedText(text, cap, "", "", "", source).text;
  let output = "";
  let used = 0;
  const available = textPlan(source, cap, suffixBytes)["out.room"]!;
  for (const character of text) {
    const bytes = utf8Bytes(character);
    if (used + bytes > available) break;
    output += character;
    used += bytes;
  }
  const omitted = textPlan(source, cap, 0, used)["out.loss"]!;
  return checkedText(text, maxBytes, output, suffix, "", omitted).text;
};

// Allocate the same protected-block room before message text loses its source handle.
export const protectedBudgets = (header: string, items: readonly string[], maxBytes: number): number[] => {
  if (items.length === 0) return [];
  let cap = byteCap(maxBytes);
  const headerBytes = utf8Bytes(header);
  let demands: number[] | undefined;
  if (!Number.isSafeInteger(cap)) {
    // If every item fits, use the exact demand as an equivalent safe ceiling.
    demands = items.map(utf8Bytes);
    const full = demands.reduce((total, bytes) => total + bytes, headerBytes + 2 * items.length);
    if (!Number.isSafeInteger(full) || full > cap) throw new RangeError("protected demand exceeds safe arithmetic");
    cap = full;
  }
  const { room, share } = protectedRoom(cap, headerBytes, items.length);
  let remaining = room;
  const assign = (demand: number): number => {
    const result = protectedItemBytes(demand, share, 0, remaining);
    remaining = result["out.afterInitial"]!;
    return result["out.initial"]!;
  };
  const budgets = demands ? demands.map(assign) : items.map((item) => assign(utf8Bytes(item)));
  let used = 0;
  return items.map((item, index) => {
    const demand = utf8Bytes(item);
    const allocation = protectedItemBytes(demand, share, budgets[index]!, remaining);
    remaining = allocation["out.remaining"]!;
    const amount = allocation["out.budget"]!;
    used = checkedProtectedTotal({ room, used, amount, demand });
    return amount;
  });
};

const charBytes = (character: string): number => {
  const code = character.codePointAt(0)!;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
};

/** The last characters of a text that fit in maxBytes, never splitting one. */
const tailUtf8 = (text: string, maxBytes: number): string => {
  const source = utf8Bytes(text), cap = byteCap(maxBytes);
  if (cap === 0) return checkedText(text, cap, "", "", "", source).text;
  if (source <= cap) return checkedText(text, cap, text, "", "", 0).text;
  const characters = [...text];
  let used = 0;
  let start = characters.length;
  for (let index = characters.length - 1; index >= 0; index--) {
    const bytes = charBytes(characters[index]!);
    if (used + bytes > cap) break;
    used += bytes;
    start = index;
  }
  const tail = characters.slice(start).join("");
  const omitted = textPlan(source, cap, 0, 0, utf8Bytes(tail))["out.loss"]!;
  return checkedText(text, maxBytes, "", "", tail, omitted).text;
};

// Formatting does no byte arithmetic, so keep finite integral counts even above the safe-integer range.
const naturalCount = (count: number): number => Number.isNaN(count) ? 0 : Math.max(0, Math.floor(count));

export const earlierSummaryOmission = (omittedBytes: number): string =>
  `\n[omitted ${naturalCount(omittedBytes)} UTF-8 bytes from the middle of the earlier summary]\n`;

/** Keep the start and the end of a text and cut the middle, stating the loss
 * where it happened. The room left after the note splits evenly, the head taking
 * the floor half. */
export const boundedHeadTail = (text: string, maxBytes: number): { text: string; omittedBytes: number } => {
  const sourceBytes = utf8Bytes(text), cap = byteCap(maxBytes);
  if (sourceBytes <= cap) return checkedText(text, cap, text, "", "", 0);
  let omitted = textPlan(sourceBytes, cap, 0, cap)["out.loss"]!;
  for (;;) {
    const plan = textPlan(sourceBytes, cap, utf8Bytes(earlierSummaryOmission(omitted)));
    if (plan["out.room"] === 0) return checkedText(text, maxBytes, "", "", "", sourceBytes);
    const head = clipUtf8(text, plan["out.half"]!, "");
    const tail = tailUtf8(text, plan["out.other"]!);
    const actual = textPlan(sourceBytes, cap, 0, utf8Bytes(head), utf8Bytes(tail))["out.loss"]!;
    const marker = earlierSummaryOmission(actual);
    const candidate = `${head}${marker}${tail}`;
    const result = textPlan(sourceBytes, cap, 0, utf8Bytes(head), utf8Bytes(tail), utf8Bytes(candidate));
    if (result["out.over"] === 0) return checkedText(text, maxBytes, head, marker, tail, actual, actual);
    // The note's own digits shifted the room; give the note the bytes it grew by.
    omitted = result["out.retry"]!;
  }
};

// Preserve complete multiline text when it fits, and make byte loss explicit.
export const boundedExcerpt = (text: string, maxBytes: number, source?: string): { text: string; omittedBytes: number } => {
  const sourceBytes = utf8Bytes(text), cap = byteCap(maxBytes);
  if (sourceBytes <= cap) return checkedText(text, cap, text, "", "", 0);
  const note = (omitted: number) => `[omitted ${omitted} UTF-8 bytes${source ? ` of ${source}` : ""}]`;
  // The full source length has at least as many digits as the omitted count.
  const marker = note(sourceBytes), markerBytes = utf8Bytes(marker);
  if (markerBytes > cap) return checkedText(text, cap, "", "", "", sourceBytes);
  const room = textPlan(sourceBytes, cap, markerBytes)["out.room"]!;
  if (room === 0) return checkedText(text, maxBytes, "", marker, "", sourceBytes, sourceBytes);
  const prefix = clipUtf8(text, textPlan(sourceBytes, room, 1)["out.room"]!, "");
  const omittedBytes = textPlan(sourceBytes, cap, 0, utf8Bytes(prefix))["out.loss"]!;
  return checkedText(text, maxBytes, prefix, `\n${note(omittedBytes)}`, "", omittedBytes, omittedBytes);
};

/** Keep the ending of an earlier reply and mark the source bytes cut from its start. */
export const boundedTailExcerpt = (text: string, maxBytes: number, source: string): { text: string; omittedBytes: number } => {
  const sourceBytes = utf8Bytes(text), cap = byteCap(maxBytes);
  if (sourceBytes <= cap) return checkedText(text, cap, text, "", "", 0);
  const note = (omitted: number) => `[omitted ${omitted} UTF-8 bytes of ${source}]`;
  const marker = note(sourceBytes), markerBytes = utf8Bytes(marker);
  if (markerBytes > cap) return checkedText(text, cap, "", "", "", sourceBytes);
  const space = textPlan(sourceBytes, cap, markerBytes)["out.room"]!;
  const room = textPlan(sourceBytes, space, 1)["out.room"]!;
  if (room === 0) return checkedText(text, maxBytes, "", marker, "", sourceBytes, sourceBytes);
  const tail = tailUtf8(text, room);
  const omittedBytes = textPlan(sourceBytes, cap, 0, 0, utf8Bytes(tail))["out.loss"]!;
  return checkedText(text, maxBytes, "", `${note(omittedBytes)}\n`, tail, omittedBytes, omittedBytes);
};

export interface AddressedValue {
  entryId: string;
}

export interface AddressedSample<T extends AddressedValue> {
  values: T[];
  omitted: number;
  omittedFirstEntryId?: string;
  omittedLastEntryId?: string;
  splitIndex: number;
}

export const sampleAddressedFrom = <T extends AddressedValue>(
  source: Iterable<T>,
  maxValues: number,
): AddressedSample<T> => {
  maxValues = byteCap(maxValues);
  if (!Number.isSafeInteger(maxValues)) {
    // The old accounting gate refused an unsafe limit after consuming the source.
    for (const _value of source) { /* preserve iteration errors and side effects */ }
    throw new Error("Addressed sample failed conservation/bound verification");
  }
  const split = textPlan(0, maxValues);
  const earliestLimit = split["out.upper"]!;
  const latestLimit = split["out.lower"]!;
  const earliest: { value: T; index: number }[] = [];
  const latest: { value: T; index: number }[] = [];
  let omitted = 0;
  let total = 0;
  let omittedFirstEntryId: string | undefined;
  let omittedLastEntryId: string | undefined;

  for (const value of source) {
    const item = { value, index: total++ };
    if (earliest.length < earliestLimit) {
      earliest.push(item);
      continue;
    }
    latest.push(item);
    if (latest.length <= latestLimit) continue;
    const displaced = latest.shift()!;
    omitted += 1;
    omittedFirstEntryId ??= displaced.value.entryId;
    omittedLastEntryId = displaced.value.entryId;
  }

  if (!acceptAddressedSample({ total, limit: maxValues, earliest: earliest.length, latest: latest.length, omitted,
    lower: latestLimit, upper: earliestLimit })) {
    throw new Error("Addressed sample failed conservation/bound verification");
  }
  const retained = [...earliest, ...latest];
  for (const [position, item] of retained.entries()) {
    if (!checkedSamplePosition({ total, first: earliest.length, last: latest.length, position, actual: item.index })) {
      throw new Error("Addressed sample failed source-position verification");
    }
  }
  return {
    values: retained.map((item) => item.value),
    omitted,
    ...(omittedFirstEntryId !== undefined ? { omittedFirstEntryId } : {}),
    ...(omittedLastEntryId !== undefined ? { omittedLastEntryId } : {}),
    splitIndex: earliest.length,
  };
};

export const sampleAddressed = <T extends AddressedValue>(
  values: readonly T[],
  maxValues: number,
): AddressedSample<T> => sampleAddressedFrom(values, byteCap(maxValues));

export const omissionLine = (
  count: number,
  firstEntryId: string | undefined,
  lastEntryId: string | undefined,
  noun: string,
): string => {
  const range = firstEntryId || lastEntryId
    ? `${firstEntryId || "(start)"} → ${lastEntryId || "(end)"}`
    : "(unknown range)";
  return `… omitted ${naturalCount(count)} ${noun}; source entries ${range}`;
};
