// Short exact excerpts are unverified. Source ids may allow best-effort Recall expansion.
import type { ClaudeMessage } from "./from-claude.ts";
import { utf8Bytes } from "./bounds.ts";
import { allocateSummaryCarry } from "./verified/context.ts";

export const LITERALS_HEADER = "[Exact values]";
export const MAX_LITERALS_SECTION_BYTES = 2048;
const MAX_VALUE_BYTES = 160;
const CREDENTIAL_WINDOW_LINES = 8;
const fits = (demand: number, room: number): boolean => allocateSummaryCarry(room, 0, demand, 0, 0).newestBytes === demand;

export interface ExactValue {
  entryId: string;
  value: string;
}

interface Candidate extends ExactValue {
  position: number;
  order: number;
  error: boolean;
}

// Match the whole whitespace-delimited token; unsupported characters invalidate it.
// Brackets and parentheses are allowed in route segments, as in Next.js paths.
const TOKEN = /\S+/g;
const PATH = /^(?:\.{0,2}\/)?(?:[A-Za-z0-9_.()[\]-]+\/)+[A-Za-z0-9_.()[\]-]+\.[A-Za-z0-9_]+$/;
const HYPHENATED = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/;
const HEX = /^[0-9a-f]{12,31}$/i;
const ERROR_CODE = /^[A-Z][A-Z_]*\d{3,}$/;
// Prefixes from the published Gitleaks and sec.versal secret-scanning lists:
// https://github.com/gitleaks/gitleaks/blob/5f6ec56cfa6f8c67648d863582c7ae2f206d5c1c/config/gitleaks.toml
// https://jsonversal.com/sec/tools/secret-scanner/
const CREDENTIAL_PREFIXES = [
  "glpat-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "xox",
  "akia", "asia", "sk_live_", "rk_live_", "aiza", "npm_", "eyj", "sk-",
];
const hasCredential = (line: string): boolean => /key|token|secret|password|passwd|authorization|bearer|credential|cookie|session/i.test(line)
  || CREDENTIAL_PREFIXES.some((prefix) => line.toLowerCase().includes(prefix));
// Longer hex runs can never fit as a complete value or error message.
const AMBIGUOUS_HEX = new RegExp(`(?<![a-f\\d])[a-f\\d]{32,${MAX_VALUE_BYTES}}(?![a-f\\d])`, "i");

const addError = (values: Set<string>, code: string, line: string, end: number): void => {
  values.add(code);
  // Inspect at most one value's worth of suffix; never retain a clipped message.
  const suffix = line.slice(end, end + MAX_VALUE_BYTES + 1);
  const detail = /^[ \t]+line[ \t]+\d+/.exec(suffix)?.[0] ?? "";
  if (detail && fits(utf8Bytes(code + detail), MAX_VALUE_BYTES)) values.add(code + detail);
  const message = /^:[^"\\`]+/.exec(suffix.slice(detail.length))?.[0];
  if (!message) return;
  const value = code + detail + message;
  const complete = end + detail.length + message.length < line.length || line.length <= end + MAX_VALUE_BYTES + 1;
  if (complete && fits(utf8Bytes(value), MAX_VALUE_BYTES)) values.add(value);
};

function* safeLines(text: string): Generator<string> {
  let remaining = 0;
  for (const line of text.split(/\n|\\n/)) {
    if (hasCredential(line)) { remaining = CREDENTIAL_WINDOW_LINES; continue; }
    if (remaining > 0) { remaining--; continue; }
    // Encoded tabs and carriage returns still separate tokens, not window lines.
    for (const part of line.split(/\\[rt]/)) {
      if (!AMBIGUOUS_HEX.test(part)) yield part;
    }
  }
}

const isLiteralToken = (value: string): boolean => HEX.test(value) || PATH.test(value)
  || (value.length >= 8 && HYPHENATED.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value));

const addToken = (values: Set<string>, match: RegExpMatchArray, line: string): void => {
  const raw = match[0];
  if (raw.length > MAX_VALUE_BYTES) return;
  const leading = /^["'`]+/.exec(raw)?.[0].length ?? 0;
  // Quotes may surround a value; only sentence punctuation may follow it.
  const value = raw.slice(leading).replace(/["'`.,;:]+$/, "");
  if (ERROR_CODE.test(value)) {
    addError(values, value, line, match.index! + leading + value.length);
  } else if (isLiteralToken(value) && fits(utf8Bytes(value), MAX_VALUE_BYTES)) {
    values.add(value);
  }
};

const valuesIn = (text: string): string[] => {
  const values = new Set<string>();
  for (const line of safeLines(text)) {
    for (const match of line.matchAll(TOKEN)) addToken(values, match, line);
  }
  return [...values];
};

const carriedValues = (summary: string): ExactValue[] => {
  const values: ExactValue[] = [];
  // Only the first outer block is ours. Later headings can be verbatim user text
  // or a nested earlier summary, neither of which may supply carried values.
  if (!summary.startsWith(`${LITERALS_HEADER}\n`)) return values;
  for (const line of summary.slice(LITERALS_HEADER.length + 1).split("\n")) {
    if (!line || line === "---" || /^\[[^\]]+\]$/.test(line)) break;
    const match = /^- \[entry ([^;\]\r\n]+)\] (.+)$/.exec(line);
    if (match && valuesIn(match[2]!).includes(match[2]!)) values.push({ entryId: match[1]!, value: match[2]! });
  }
  return values;
};

/** Collect only from summarized replies and tool results, never tool inputs or user text.
 * Dialogue after a source may rank it, including dialogue in the kept tail. */
export const exactValues = (messages: readonly ClaudeMessage[], start: number, earlierSummary = ""): ExactValue[] => {
  const candidates: Candidate[] = carriedValues(earlierSummary).map((value, order) => ({
    ...value, position: -1, order, error: /^\b[A-Z][A-Z_]*\d{3,}\b/.test(value.value),
  }));
  const add = (values: readonly string[], entryId: string, position: number, error: boolean) => {
    for (const value of values) candidates.push({ entryId, value, position, order: candidates.length, error: error || /^\b[A-Z][A-Z_]*\d{3,}\b/.test(value) });
  };
  const addToolResults = (message: ClaudeMessage, entryId: string, position: number) => {
    // A stored outcome on a call is not present in that call’s transcript row.
    for (const result of message.toolResults ?? []) add(valuesIn(result.text), entryId, position, result.isError);
  };
  const lastDialogue = new Map<string, number>();
  messages.forEach((message, index) => {
    const isSummary = message.text.trimStart().startsWith("[Fabric summary]");
    const dialogueValues = message.text && !isSummary ? valuesIn(message.text) : [];
    for (const value of dialogueValues) lastDialogue.set(value, index);
    if (index >= start || isSummary) return;
    const id = message.handle ?? message.uuid;
    if (!id) throw new Error("fabric: a message has no source handle for recall");
    if (message.role === "assistant") add(dialogueValues, id, index, false);
    addToolResults(message, id, index);
  });
  candidates.sort((a, b) => {
    const echoed = Number((lastDialogue.get(b.value) ?? -1) > b.position) - Number((lastDialogue.get(a.value) ?? -1) > a.position);
    return echoed || Number(b.error) - Number(a.error) || b.position - a.position || b.order - a.order;
  });
  const seen = new Set<string>();
  return candidates.filter(({ value }) => !seen.has(value) && !!seen.add(value))
    .map(({ entryId, value }) => ({ entryId, value }));
};

/** Keep complete values only; no clipping can make an exact value misleading. */
export const renderExactValues = (values: readonly ExactValue[], budget: number): string => {
  if (values.length === 0 || utf8Bytes(LITERALS_HEADER) > budget) return "";
  let text = `${LITERALS_HEADER}\nUnverified excerpts. Source ids; Recall expansion is best-effort.`;
  let used = utf8Bytes(text);
  for (const { entryId, value } of values) {
    const line = `\n- [entry ${entryId}] ${value}`;
    const bytes = utf8Bytes(line);
    if (fits(used + bytes, budget)) { text += line; used += bytes; }
  }
  return text.includes("\n- [entry ") ? text : "";
};
