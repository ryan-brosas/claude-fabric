// Copied from pi-fabric (MIT, Tom X Nguyen) src/compaction/bounds.ts at d331f629; dropped canonicalizeText, which only the typed compaction requests used.
import { acceptSampleAccounting } from "./verified/policy.ts";

export const MAX_SUMMARY_BYTES = 32 * 1024;
export const MAX_RENDERED_LINE_BYTES = 1024;
export const EARLIER_USERS_HEADER = "[Earlier user messages]";
export const MAX_EARLIER_USERS_SECTION_BYTES = 8192;

const encoder = new TextEncoder();

export const utf8Bytes = (text: string): number => encoder.encode(text).byteLength;

export const clipUtf8 = (text: string, maxBytes: number, suffix = "…"): string => {
  if (maxBytes <= 0) return "";
  if (utf8Bytes(text) <= maxBytes) return text;
  const suffixBytes = utf8Bytes(suffix);
  if (suffixBytes >= maxBytes) return "";
  let output = "";
  let used = 0;
  const available = maxBytes - suffixBytes;
  for (const character of text) {
    const bytes = utf8Bytes(character);
    if (used + bytes > available) break;
    output += character;
    used += bytes;
  }
  return `${output}${suffix}`;
};

// Allocate the same protected-block room before message text loses its source handle.
export const protectedBudgets = (header: string, items: readonly string[], maxBytes: number): number[] => {
  if (items.length === 0) return [];
  let remaining = Math.max(0, maxBytes - utf8Bytes(header) - 2 * items.length);
  const share = Math.floor(remaining / items.length);
  const budgets = items.map((item) => Math.min(utf8Bytes(item), share));
  remaining -= budgets.reduce((sum, bytes) => sum + bytes, 0);
  return items.map((item, index) => {
    const extra = Math.min(remaining, utf8Bytes(item) - budgets[index]!);
    remaining -= extra;
    return budgets[index]! + extra;
  });
};

const charBytes = (character: string): number => {
  const code = character.codePointAt(0)!;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
};

/** The last characters of a text that fit in maxBytes, never splitting one. */
const tailUtf8 = (text: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";
  const characters = [...text];
  let used = 0;
  let start = characters.length;
  for (let index = characters.length - 1; index >= 0; index--) {
    const bytes = charBytes(characters[index]!);
    if (used + bytes > maxBytes) break;
    used += bytes;
    start = index;
  }
  return characters.slice(start).join("");
};

export const earlierSummaryOmission = (omittedBytes: number): string =>
  `\n[omitted ${omittedBytes} UTF-8 bytes from the middle of the earlier summary]\n`;

/** Keep the start and the end of a text and cut the middle, stating the loss
 * where it happened. The room left after the note splits evenly, the head taking
 * the floor half. */
export const boundedHeadTail = (text: string, maxBytes: number): { text: string; omittedBytes: number } => {
  const sourceBytes = utf8Bytes(text);
  if (sourceBytes <= maxBytes) return { text, omittedBytes: 0 };
  let omitted = sourceBytes - maxBytes;
  for (;;) {
    const room = maxBytes - utf8Bytes(earlierSummaryOmission(omitted));
    if (room <= 0) return { text: "", omittedBytes: sourceBytes };
    const head = clipUtf8(text, Math.floor(room / 2), "");
    const tail = tailUtf8(text, room - Math.floor(room / 2));
    const actual = sourceBytes - utf8Bytes(head) - utf8Bytes(tail);
    const candidate = `${head}${earlierSummaryOmission(actual)}${tail}`;
    const over = utf8Bytes(candidate) - maxBytes;
    if (over <= 0) return { text: candidate, omittedBytes: actual };
    // The note's own digits shifted the room; give the note the bytes it grew by.
    omitted = actual + over;
  }
};

// Preserve complete multiline text when it fits, and make byte loss explicit.
export const boundedExcerpt = (text: string, maxBytes: number, source?: string): { text: string; omittedBytes: number } => {
  const sourceBytes = utf8Bytes(text);
  if (sourceBytes <= maxBytes) return { text, omittedBytes: 0 };
  const note = (omitted: number) => `[omitted ${omitted} UTF-8 bytes${source ? ` of ${source}` : ""}]`;
  // The full source length has at least as many digits as the omitted count.
  const marker = note(sourceBytes);
  const room = maxBytes - utf8Bytes(marker);
  if (room < 0) return { text: "", omittedBytes: sourceBytes };
  if (room === 0) return { text: marker, omittedBytes: sourceBytes };
  const prefix = clipUtf8(text, room - 1, "");
  const omittedBytes = sourceBytes - utf8Bytes(prefix);
  return { text: `${prefix}\n${note(omittedBytes)}`, omittedBytes };
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
  const earliestLimit = Math.ceil(maxValues / 2);
  const latestLimit = Math.floor(maxValues / 2);
  const earliest: T[] = [];
  const latest: T[] = [];
  let omitted = 0;
  let total = 0;
  let omittedFirstEntryId: string | undefined;
  let omittedLastEntryId: string | undefined;

  for (const value of source) {
    total++;
    if (earliest.length < earliestLimit) {
      earliest.push(value);
      continue;
    }
    latest.push(value);
    if (latest.length <= latestLimit) continue;
    const displaced = latest.shift()!;
    omitted += 1;
    omittedFirstEntryId ??= displaced.entryId;
    omittedLastEntryId = displaced.entryId;
  }

  if (!acceptSampleAccounting(total, earliest.length + latest.length, omitted, maxValues)) {
    throw new Error("Addressed sample failed conservation/bound verification");
  }
  return {
    values: [...earliest, ...latest],
    omitted,
    ...(omittedFirstEntryId !== undefined ? { omittedFirstEntryId } : {}),
    ...(omittedLastEntryId !== undefined ? { omittedLastEntryId } : {}),
    splitIndex: earliest.length,
  };
};

export const sampleAddressed = <T extends AddressedValue>(
  values: readonly T[],
  maxValues: number,
): AddressedSample<T> => sampleAddressedFrom(values, maxValues);

export const omissionLine = (
  count: number,
  firstEntryId: string | undefined,
  lastEntryId: string | undefined,
  noun: string,
): string => {
  const range = firstEntryId || lastEntryId
    ? `${firstEntryId || "(start)"} → ${lastEntryId || "(end)"}`
    : "(unknown range)";
  return `… omitted ${count} ${noun}; source entries ${range}`;
};
