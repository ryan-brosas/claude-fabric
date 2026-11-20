// Adapted from pi-fabric (MIT, Tom X Nguyen) packages/pi-recall/src/verified/{memory,policy}.ts at d331f629;
// the source-slice and contiguous-cursor check stays a plain TypeScript assertion.
import type { Entry } from "./transcript.ts";
export interface TextRange { start: number; end: number; total: number; complete: boolean }
export interface PageEntry { uuid: string; kind: Entry["kind"]; text: string; textRange: TextRange }
export interface Cursor { position: number; textOffset: number }
export function acceptsExpansionPage(records: readonly PageEntry[], source: readonly Entry[], start: Cursor, cursor: Cursor): boolean {
  if (![start.position, start.textOffset, cursor.position, cursor.textOffset].every((n) => Number.isSafeInteger(n) && n >= 0)) return false;
  let position = start.position, offset = start.textOffset;
  for (const record of records) {
    const entry = source[position], range = record.textRange;
    if (!entry || record.uuid !== entry.uuid || !range || range.start !== offset || range.total !== entry.text.length ||
      !Number.isSafeInteger(range.end) || range.end < range.start || range.end > range.total ||
      range.end - range.start !== record.text.length || record.text !== entry.text.slice(range.start, range.end) ||
      range.complete !== (range.end === range.total) || (!range.complete && range.end === range.start)) return false;
    if (range.complete) { position++; offset = 0; } else offset = range.end;
  }
  return position === cursor.position && offset === cursor.textOffset && (records.length > 0 || position === source.length);
}
