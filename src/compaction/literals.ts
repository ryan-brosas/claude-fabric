// Short exact excerpts are unverified. Source ids may allow best-effort Recall expansion.
import { hasOutcome, inlineOutcome, type ClaudeMessage } from "./from-claude.ts";
import { clipUtf8, utf8Bytes } from "./bounds.ts";
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
  errorCode: boolean;
  missingUser: boolean;
  userOrder: number;
  shown: boolean;
}

// Match the whole whitespace-delimited token; unsupported characters invalidate it.
// Brackets and parentheses are allowed in route segments, as in Next.js paths.
const TOKEN = /\S+/g;
const PATH = /^(?:\.{0,2}\/)?(?:[A-Za-z0-9_.()[\]-]+\/)+[A-Za-z0-9_.()[\]-]+\.[A-Za-z0-9_]+$/;
const HYPHENATED = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/;
const HEX = /^[0-9a-f]{12,31}$/i;
const ERROR_CODE = /^[A-Z][A-Z_]*\d{3,}$/;
const ERROR_EXCERPT = /^[A-Z][A-Z_]*\d{3,}\b/;
// Prefixes from the published Gitleaks and sec.versal secret-scanning lists:
// https://github.com/gitleaks/gitleaks/blob/5f6ec56cfa6f8c67648d863582c7ae2f206d5c1c/config/gitleaks.toml
// https://jsonversal.com/sec/tools/secret-scanner/
const CREDENTIAL_PREFIXES = [
  "glpat-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "xox",
  "akia", "asia", "sk_live_", "rk_live_", "aiza", "npm_", "eyj", "sk-",
];
const hasCredential = (line: string): boolean => /key|token|secret|password|passwd|passphrase|authorization|bearer|credential|cookie|session|(?:^|[^a-z0-9])(?:pin|otp|passcode|(?:one[-_\s]+time|verification|security|2fa|recovery)[-_\s]+code)(?=$|[^a-z0-9])/i.test(line)
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

export const valuesIn = (text: string): string[] => {
  const values = new Set<string>();
  for (const line of safeLines(text)) {
    for (const match of line.matchAll(TOKEN)) addToken(values, match, line);
  }
  return [...values];
};

// These patterns operate only on bounded whitespace-delimited tokens. Their work is
// linear in the input even for an arbitrarily long line or token.
const USER_HOST = /^(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*|[a-z0-9][a-z0-9.-]*):?\d*$/i;
const USER_NAME = /^[a-z][a-z0-9_-]*$/i;
const USER_VALUE = /^[a-z0-9][a-z0-9_-]*$/i;
const meaningfulValue = (value: string): boolean => USER_VALUE.test(value) && /[\d_-]/.test(value);
const cleanUserToken = (token: string): string => token.replace(/^["'`([{]+|["'`)\]},;.!?]+$/g, "");

// Keep complete words around the match. Both sides inspect at most 160 code units;
// the complete excerpt shares the existing exact-value byte bound.
const userWindow = (line: string, start: number, end: number, shortLine: boolean): string => {
  if (shortLine) return line.trim();
  const match = line.slice(start, end);
  const matchBytes = utf8Bytes(match);
  if (matchBytes > MAX_VALUE_BYTES) return "";
  const before = line.slice(Math.max(0, start - MAX_VALUE_BYTES), start);
  let prefix = "";
  const prefixRoom = Math.floor((MAX_VALUE_BYTES - matchBytes) / 2);
  for (const char of [...before].reverse()) {
    if (utf8Bytes(prefix) + utf8Bytes(char) > prefixRoom) break;
    prefix = char + prefix;
  }
  if (prefix.length < start && prefix && !/\s/.test(line[start - prefix.length - 1] ?? "")) prefix = prefix.replace(/^\S*\s*/, "");
  const suffixRoom = MAX_VALUE_BYTES - matchBytes - utf8Bytes(prefix);
  const rest = line.slice(end, end + MAX_VALUE_BYTES + 1);
  let suffix = clipUtf8(rest, suffixRoom, "");
  if (suffix.length < line.length - end && suffix && !/\s/.test(line[end + suffix.length] ?? "")) suffix = suffix.replace(/\S+$/, "");
  return `${prefix}${match}${suffix}`.trim();
};

export const userExcerpts = (text: string): string[] => {
  const values = new Set<string>();
  for (const line of safeLines(text)) {
    const shortLine = utf8Bytes(line) <= MAX_VALUE_BYTES;
    let previous = "", beforePrevious = "", previousStart = 0, beforePreviousStart = 0;
    let first = -1, last = -1;
    const flush = (): void => {
      if (first < 0) return;
      const excerpt = userWindow(line, first, last, shortLine);
      if (excerpt && fits(utf8Bytes(excerpt), MAX_VALUE_BYTES)) values.add(excerpt);
    };
    for (const match of line.matchAll(TOKEN)) {
      const raw = match[0];
      const token = raw.length <= MAX_VALUE_BYTES ? cleanUserToken(raw) : "";
      const host = token && USER_HOST.test(token) && (token.includes(".") || /:\d+$/.test(token));
      const binding = /^([a-z][a-z0-9_-]*)[:=]([a-z0-9][a-z0-9_-]*)$/i.exec(token);
      const adjacentName = /[:=]$/.test(previous) && USER_NAME.test(previous.slice(0, -1));
      const separateName = (/^(?:is|are|=|:)$/i.test(previous) && USER_NAME.test(beforePrevious));
      const namedValue = meaningfulValue(token) && (adjacentName || separateName);
      if (host || (binding && meaningfulValue(binding[2]!)) || namedValue) {
        const start = namedValue ? (adjacentName ? previousStart : beforePreviousStart) : match.index!;
        const end = match.index! + raw.length;
        if (first >= 0 && (end - first > MAX_VALUE_BYTES || utf8Bytes(line.slice(first, end)) > MAX_VALUE_BYTES)) {
          flush();
          first = -1;
        }
        if (first < 0) first = start;
        last = end;
      }
      beforePrevious = previous;
      beforePreviousStart = previousStart;
      previous = token;
      previousStart = match.index!;
    }
    flush();
  }
  return [...values];
};

export const carriedValues = (summary: string): ExactValue[] => {
  const values: ExactValue[] = [];
  // Only the first outer block is ours. Later headings can be verbatim user text
  // or a nested earlier summary, neither of which may supply carried values.
  if (!summary.startsWith(`${LITERALS_HEADER}\n`)) return values;
  for (const line of summary.slice(LITERALS_HEADER.length + 1).split("\n")) {
    if (!line || line === "---" || /^\[[^\]]+\]$/.test(line)) break;
    const match = /^- \[entry ([^;\]\r\n]+)\] (.+)$/.exec(line);
    if (match && (valuesIn(match[2]!).includes(match[2]!) || userExcerpts(match[2]!).includes(match[2]!))) {
      values.push({ entryId: match[1]!, value: match[2]! });
    }
  }
  return values;
};

/** Collect summarized replies, tool results and user-stated values, never inputs or the kept tail.
 * Dialogue after a source may rank it, including dialogue in the kept tail.
 * summaryIndexes is the same Carry classification the compactor uses. */
export const exactValues = (messages: readonly ClaudeMessage[], start: number, earlierSummary = "", summaryIndexes: ReadonlySet<number>, wholeUsers: ReadonlySet<string> = new Set(), protectedText = ""): ExactValue[] => {
  const candidates: Candidate[] = carriedValues(earlierSummary).map((value, order) => ({
    ...value, position: -1, order, error: ERROR_EXCERPT.test(value.value), errorCode: ERROR_EXCERPT.test(value.value),
    missingUser: !valuesIn(value.value).includes(value.value), userOrder: order, shown: protectedText.includes(value.value),
  }));
  const resultTexts = new Map<string, Set<string>>();
  for (const message of messages.slice(0, start)) for (const result of message.toolResults ?? []) {
    const texts = resultTexts.get(result.tool_use_id) ?? new Set<string>();
    texts.add(result.text);
    resultTexts.set(result.tool_use_id, texts);
  }
  const inlineOutcomes = new Map(messages.slice(0, start).flatMap((message) =>
    (message.toolUses ?? []).filter(hasOutcome).map((use) => [use.tool_use_id, inlineOutcome(use)] as const)));
  const add = (values: readonly string[], entryId: string, position: number, error: boolean, missingUser = false) => {
    values.forEach((value, index) => candidates.push({ entryId, value, position, order: candidates.length,
      error: error || ERROR_EXCERPT.test(value), errorCode: ERROR_EXCERPT.test(value),
      missingUser, userOrder: values.length - index - 1, shown: protectedText.includes(value) }));
  };
  const addToolResults = (message: ClaudeMessage, entryId: string, position: number) => {
    for (const use of message.toolUses ?? []) {
      if (use.text && !resultTexts.get(use.tool_use_id)?.has(use.text)) add(valuesIn(use.text), entryId, position, use.isError === true);
    }
    for (const result of message.toolResults ?? []) {
      const inline = inlineOutcomes.get(result.tool_use_id);
      if (!inline || inline.text === result.text) add(valuesIn(result.text), entryId, position, inline?.isError ?? result.isError);
    }
  };
  const lastDialogue = new Map<string, number>();
  messages.forEach((message, index) => {
    const isSummary = summaryIndexes.has(index);
    const dialogueValues = message.text && !isSummary ? valuesIn(message.text) : [];
    for (const value of dialogueValues) lastDialogue.set(value, index);
    if (index >= start || isSummary) return;
    const id = message.handle ?? message.uuid;
    if (!id) throw new Error("fabric: a message has no source handle for recall");
    if (message.role === "assistant") add(dialogueValues, id, index, false);
    else if (message.text) add(userExcerpts(message.text), id, index, false, !wholeUsers.has(id));
    addToolResults(message, id, index);
  });
  const echoed = (candidate: Candidate): boolean => (lastDialogue.get(candidate.value) ?? -1) > candidate.position;
  const priority = (candidate: Candidate): number => {
    const salient = echoed(candidate) || candidate.error;
    if (!candidate.shown && (candidate.missingUser || salient)) return 0;
    if (salient) return 1;
    return candidate.missingUser ? 2 : 3;
  };
  candidates.sort((a, b) => {
    // Preserve echoed values first. Among otherwise equal candidates, actual
    // error excerpts beat the incidental paths in a failed log.
    const rank = priority(a) - priority(b) || Number(echoed(b)) - Number(echoed(a)) || Number(b.errorCode) - Number(a.errorCode)
      || Number(b.error) - Number(a.error) || Number(b.missingUser) - Number(a.missingUser);
    if (rank) return rank;
    // One excerpt per source before a second: one long clipped message must not
    // crowd out every other missing user message. Newest wins each round.
    if (a.missingUser) return a.userOrder - b.userOrder || b.position - a.position || b.order - a.order;
    return b.position - a.position || b.order - a.order;
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
