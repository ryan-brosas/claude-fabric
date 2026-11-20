// Adapted from pi-fabric (MIT, Tom X Nguyen) packages/pi-recall/src/memory/{context,expand-service}.ts at d331f629;
// a live Claude transcript is bound by its byte-length and prefix hash, not by the whole file.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { acceptsExpansionPage, type Cursor, type PageEntry } from "./page.ts";
import { search } from "./search.ts";
import { parseTranscript, type Entry } from "./transcript.ts";
import { decide } from "./verified/policy.ts";

export interface Binding { bytes: number; sha256: string }
export interface RecallArgs { query: string; limit?: number; offset?: number }
export interface ExpandArgs {
  binding: Binding; entryIds?: string[]; range?: { first: string; last: string };
  before?: number; after?: number; maxEntries?: number; maxChars?: number; entryOffset?: number; textOffset?: number;
}
export interface Hit { uuid: string; kind: Entry["kind"]; score: number; snippet: string; truncated: boolean; follow: ExpandArgs }
export interface RecallResult { binding: Binding; hits: Hit[]; total: number; unresolvable: string[]; next: RecallArgs | null }
export interface ExpandResult { entries: PageEntry[]; next: ExpandArgs | null }
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const positive = (value: number | undefined, name: string): void => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`history: ${name} must be a positive safe integer`);
};
const natural = (value: number | undefined, name: string): number => {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`history: ${name} must be a non-negative safe integer`);
  return value;
};
const transcript = async (path: string): Promise<Buffer> => {
  if (!path) throw new Error("history: the session transcript path is unknown; the mod has not published it");
  try { return await readFile(path); } catch (error) {
    throw new Error(`history: the session transcript cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/** Search the current session; each hit carries the exact expansion arguments. */
export async function recall(path: string, args: RecallArgs): Promise<RecallResult> {
  if (typeof args.query !== "string" || !args.query.trim()) throw new Error("history.recall: query must be a nonempty string");
  positive(args.limit, "limit");
  const offset = natural(args.offset, "offset");
  const limit = decide({ limit: args.limit }).limit;
  const bytes = await transcript(path);
  const binding = { bytes: bytes.length, sha256: hash(bytes) };
  const parsed = parseTranscript(bytes.toString("utf8"));
  const matches = search(parsed.entries, args.query);
  const unresolvable = [...new Set(parsed.boundaries.flatMap((boundary) => boundary.unresolvable))];
  let selected = matches.slice(offset, offset + limit);
  const result = (): RecallResult => ({ binding, total: matches.length, unresolvable,
    hits: selected.map(({ entry, score, snippet, truncated }) => ({ uuid: entry.uuid, kind: entry.kind, score, snippet, truncated,
      follow: { binding, entryIds: [entry.uuid] } })),
    next: offset + selected.length < matches.length ? { ...args, offset: offset + selected.length } : null });
  let page = result();
  while (selected.length > 1 && !decide({ responseChars: JSON.stringify(page).length }).responseOK) {
    selected = selected.slice(0, -1); page = result();
  }
  if (!decide({ responseChars: JSON.stringify(page).length }).responseOK) throw new Error("history.recall: response cannot fit in 30000 characters; narrow the query");
  return page;
}

/** Expand one bound snapshot by UUID, a UUID range, or context around one UUID. */
export async function expand(path: string, args: ExpandArgs): Promise<ExpandResult> {
  const binding = args.binding;
  if (!binding || !Number.isSafeInteger(binding.bytes) || binding.bytes < 0 || !/^[a-f0-9]{64}$/.test(binding.sha256)) {
    throw new Error("history.expand: binding must have a byte count and SHA-256 from history.recall");
  }
  positive(args.maxEntries, "maxEntries"); positive(args.maxChars, "maxChars");
  if (args.maxChars === 1) throw new Error("history.expand: maxChars must be at least 2");
  const before = decide({ context: natural(args.before, "before") }).context;
  const after = decide({ context: natural(args.after, "after") }).context;
  const bounds = decide({ entries: args.maxEntries, chars: args.maxChars });
  const entryOffset = natural(args.entryOffset, "entryOffset"), textOffset = natural(args.textOffset, "textOffset");
  const bytes = await transcript(path);
  const prefix = bytes.subarray(0, binding.bytes);
  const actual = hash(prefix);
  if (!decide({ present: bytes.length >= binding.bytes, same: actual === binding.sha256 }).bound) {
    throw new Error(`history.expand: transcript prefix changed; expected ${binding.sha256}, actual ${actual}`);
  }
  const entries = parseTranscript(prefix.toString("utf8")).entries;
  const index = new Map(entries.map((entry, i) => [entry.uuid, i]));
  const ids = args.entryIds ?? [];
  if ((ids.length > 0) === Boolean(args.range)) throw new Error("history.expand: choose entryIds or one inclusive range");
  const locate = (uuid: string): number => {
    const found = index.get(uuid);
    if (found === undefined) throw new Error(`history.expand: uuid ${JSON.stringify(uuid)} was not found on the active chain`);
    return found;
  };
  let positions: number[];
  if (args.range) {
    const first = locate(args.range.first), last = locate(args.range.last);
    if (first > last) throw new Error("history.expand: range must follow transcript order");
    const count = last - first + 1;
    if (!decide({ range: count }).rangeOK) throw new Error("history.expand: range exceeds the 20-entry cap");
    positions = Array.from({ length: count }, (_, i) => first + i);
  } else {
    if (!decide({ range: ids.length }).rangeOK) throw new Error("history.expand: entryIds exceeds the 20-entry cap");
    positions = [...new Set(ids.map(locate))].sort((a, b) => a - b);
  }
  if (before || after) {
    if (positions.length !== 1) throw new Error("history.expand: before/after needs exactly one anchor");
    const anchor = positions[0]!;
    const start = Math.max(0, anchor - before), end = Math.min(entries.length - 1, anchor + after);
    positions = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }
  const selected = positions.map((position) => entries[position]!);
  if (entryOffset > selected.length || (entryOffset === selected.length && textOffset !== 0) ||
      (entryOffset < selected.length && textOffset > selected[entryOffset]!.text.length)) {
    throw new Error("history.expand: continuation is outside the selected text");
  }
  const start: Cursor = { position: entryOffset, textOffset };
  let cursor = { ...start }, remaining = bounds.chars;
  const output: PageEntry[] = [], cursors: Cursor[] = [];
  while (cursor.position < selected.length && output.length < bounds.entries && remaining > 0) {
    const entry = selected[cursor.position]!;
    const from = cursor.textOffset;
    let end = Math.min(entry.text.length, from + remaining);
    if (end < entry.text.length && end > from && /[\uDC00-\uDFFF]/.test(entry.text[end]!)) end--;
    if (end === from && from < entry.text.length) break;
    const text = entry.text.slice(from, end), complete = end === entry.text.length;
    output.push({ uuid: entry.uuid, kind: entry.kind, text, textRange: { start: from, end, total: entry.text.length, complete } });
    remaining -= text.length;
    cursor = complete ? { position: cursor.position + 1, textOffset: 0 } : { position: cursor.position, textOffset: end };
    cursors.push(cursor);
    if (!complete) break;
  }
  const response = (): ExpandResult => ({ entries: output,
    next: cursor.position < selected.length ? { ...args, entryOffset: cursor.position, textOffset: cursor.textOffset } : null });
  let page = response();
  while (output.length > 1 && !decide({ responseChars: JSON.stringify(page).length }).responseOK) {
    output.pop(); cursors.pop(); cursor = cursors.at(-1) ?? start; page = response();
  }
  if (output.length === 1 && !decide({ responseChars: JSON.stringify(page).length }).responseOK) {
    // JSON escaping can double the size of a page even when its source text fits.
    const record = output[0]!, whole = record.text, from = record.textRange.start;
    const keep = (size: number): void => {
      const safe = size > 0 && size < whole.length && /[\uDC00-\uDFFF]/.test(whole[size]!) ? size - 1 : size;
      record.text = whole.slice(0, safe);
      record.textRange.end = from + safe;
      record.textRange.complete = record.textRange.end === record.textRange.total;
      cursor = record.textRange.complete ? { position: start.position + 1, textOffset: 0 } : { position: start.position, textOffset: record.textRange.end };
      page = response();
    };
    let low = 1, high = whole.length, best = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      keep(middle);
      if (record.text.length && decide({ responseChars: JSON.stringify(page).length }).responseOK) { best = middle; low = middle + 1; }
      else high = middle - 1;
    }
    if (best) keep(best);
  }
  if (!decide({ responseChars: JSON.stringify(page).length }).responseOK) throw new Error("history.expand: response exceeds 30000 characters; narrow the selection");
  const pageChars = output.reduce((sum, item) => sum + item.text.length, 0);
  if (!decide({ pageChars }).pageOK || !acceptsExpansionPage(output, selected, start, cursor)) {
    throw new Error("history.expand: expansion failed source-slice verification");
  }
  return page;
}
