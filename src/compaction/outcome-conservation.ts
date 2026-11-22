// The rebuild must not discard any effective outcome the hook can see now. The compactor
// gives an inline tool-use outcome precedence over result rows with the same id.
import { exitCodeOf, hasOutcome, inlineOutcome, type ClaudeMessage, type ClaudeToolUse } from "./from-claude.ts";
import { outcomeConservation } from "./verified/generated/outcome-conservation.js";
import { buildKeptReadStub, eligibleKeptRead, readDigest, textOf, wholeReadPath } from "./kept-read.ts";
import { utf8Bytes } from "./bounds.ts";
import type { TranscriptRow } from "../recall/transcript.ts";

type ResolvedText = { original: string; entryId?: string };
type Resolver = (id: string, text: string, isError?: boolean) => ResolvedText;
const emptyFacts = { required: 0, available: 0, entryFound: 0, sameId: 0, bytesEqual: 0,
  digestMatches: 0, stubEqual: 0, eligible: 0, sameText: 0 };
const decide = (facts: Partial<typeof emptyFacts>) =>
  outcomeConservation.step({}, outcomeConservation.init({}), { ...emptyFacts, ...facts }).scalars;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

// A forged stub can resolve only to the transcript's eligible whole-file outcome for
// the same tool_use_id and committed bytes. Assuming the transcript is authoritative,
// it cannot introduce text that the recorded call did not return. This is not an
// authorship proof and cannot detect an attacker rewriting both transcript and stub.
export function outcomeResolver(rows: ReadonlyMap<string, TranscriptRow>, messages: readonly ClaudeMessage[]): Resolver {
  const calls = new Map<string, { use: ClaudeToolUse; transcript: boolean }[]>();
  const add = (use: ClaudeToolUse, transcript: boolean) => {
    const matches = calls.get(use.tool_use_id) ?? [];
    matches.push({ use, transcript }); calls.set(use.tool_use_id, matches);
  };
  for (const message of messages) for (const use of message.toolUses) add(use, false);
  for (const row of rows.values()) {
    if (row.type !== "assistant" || row.isSidechain === true) continue;
    const content = object(row.message).content;
    if (!Array.isArray(content)) continue;
    for (const part of content.map(object)) {
      if (part.type !== "tool_use" || typeof part.id !== "string" || typeof part.name !== "string") continue;
      const use: ClaudeToolUse = { tool_use_id: part.id, tool: part.name, input: object(part.input) };
      // The writer verifies a unique matching tool-use block in its call row.
      add(use, content.filter((item) => object(item).type === "tool_use" && object(item).id === part.id).length === 1);
    }
  }
  return (id, text, isError = false) => {
    const unchanged = { original: text };
    if (isError) return unchanged;
    // Captures are only lookup hints. Acceptance compares the complete rebuilt string.
    const match = /^\[[^\n]*: (\d+) UTF-8 bytes\.[^\n]*\]\nFile: (.+)\nTranscript entry: ([^\r\n]+)\nSHA-256: ([a-f0-9]{64})\n/.exec(text);
    if (!match) return unchanged;
    let path: unknown;
    try { path = JSON.parse(match[2]!); } catch { return unchanged; }
    const row = rows.get(match[3]!);
    const content = object(row?.message).content;
    const block = Array.isArray(content) && content.length === 1 ? object(content[0]) : {};
    const original = textOf(block.content);
    const entryFound = !!row && row.isSidechain !== true && row.type === "user" && block.type === "tool_result"
      && block.is_error !== true && original !== undefined;
    const sameId = block.tool_use_id === id;
    const count = Number(match[1]);
    const bytesEqual = original !== undefined && Number.isSafeInteger(count) && utf8Bytes(original) === count;
    const digestMatches = original !== undefined && readDigest(original) === match[4];
    const stubEqual = typeof path === "string" && original !== undefined && text === buildKeptReadStub(path, match[3]!, original);
    const uses = calls.get(id) ?? [];
    const eligible = original !== undefined && uses.some((call) => call.transcript) && uses.every(({ use }) =>
      wholeReadPath(use) === path && eligibleKeptRead(use, row, match[3]!, original, text));
    const verdict = decide({ entryFound: Number(entryFound), sameId: Number(sameId), bytesEqual: Number(bytesEqual),
      digestMatches: Number(digestMatches), stubEqual: Number(stubEqual), eligible: Number(eligible) });
    return verdict["out.verified"] === 1 ? { original: original!, entryId: match[3]! } : unchanged;
  };
}

function sameText(left: string, right: string): boolean {
  return decide({ sameText: Number(left === right) })["out.same"] === 1;
}

/** Resolve the rebuilding view while preserving the identity of every unchanged message. */
export function resolveMessageOutcomes(messages: readonly ClaudeMessage[], resolve: Resolver): ClaudeMessage[] {
  return messages.map((message) => {
    let changed = false;
    const uses = message.toolUses.map((use) => {
      if (use.text === undefined) return use;
      const found = resolve(use.tool_use_id, use.text, use.isError === true);
      if (!found.entryId) return use;
      changed = true;
      return { ...use, text: found.original };
    });
    let address: string | undefined;
    const results = message.toolResults?.map((result) => {
      // The writer only creates standalone result rows. Changing a mixed row's
      // address would attribute unrelated content to the wrong source.
      if (message.role !== "user" || message.text || message.toolUses.length || message.toolResults?.length !== 1) return result;
      const found = resolve(result.tool_use_id, result.text, result.isError);
      if (!found.entryId) return result;
      changed = true; address = found.entryId;
      return { ...result, text: found.original, isError: false };
    });
    if (!changed) return message;
    return { ...message, toolUses: uses, ...(results ? { toolResults: results } : {}), ...(address ? { handle: address } : {}) };
  });
}

/** Resolve physical rows without changing the UUID keys used to walk the transcript. */
export function resolveTranscriptOutcomes(rows: ReadonlyMap<string, TranscriptRow>, resolve: Resolver): {
  rows: Map<string, TranscriptRow>; addresses: Map<string, string>;
} {
  const resolved = new Map<string, TranscriptRow>(), addresses = new Map<string, string>();
  for (const [id, row] of rows) {
    const message = object(row.message), content = message.content;
    if (row.type !== "user" || !Array.isArray(content) || content.length !== 1) { resolved.set(id, row); continue; }
    const block = object(content[0]);
    const text = textOf(block.content);
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string" || text === undefined) { resolved.set(id, row); continue; }
    const found = resolve(block.tool_use_id, text, block.is_error === true);
    if (!found.entryId) { resolved.set(id, row); continue; }
    addresses.set(id, found.entryId);
    resolved.set(id, { ...row, message: { ...message, content: [{ ...block, content: found.original, is_error: false }] } });
  }
  return { rows: resolved, addresses };
}

type Outcome = { text: string; isError: boolean; effectiveError: boolean; count: number };
type Outcomes = { values: Map<string, Outcome>; calls: Map<string, ClaudeToolUse> };

function outcomes(messages: readonly ClaudeMessage[]): Outcomes {
  const calls = new Map<string, ClaudeToolUse>();
  const answered = new Set<string>();
  for (const message of messages) for (const use of message.toolUses ?? []) {
    const previous = calls.get(use.tool_use_id);
    if (previous && previous.tool !== use.tool) throw new Error("conflicting tool use id");
    calls.set(use.tool_use_id, use);
    if (hasOutcome(use)) {
      if (message.role !== "assistant") throw new Error("ambiguous tool outcome on a non-assistant use");
      answered.add(use.tool_use_id);
    }
  }
  const values = new Map<string, Outcome>();
  const add = (id: string, text: string, isError: boolean, tool: string, result: unknown): void => {
    if (typeof id !== "string" || !id || typeof text !== "string" || typeof isError !== "boolean") {
      throw new Error("ambiguous tool outcome fields");
    }
    const exit = tool === "Bash" ? exitCodeOf(result ?? calls.get(id)?.result) : null;
    const effectiveError = isError || (exit !== null && exit !== 0);
    const current = text;
    const previous = values.get(id);
    if (previous && (!sameText(previous.text, current) || previous.isError !== isError || previous.effectiveError !== effectiveError)) {
      throw new Error("conflicting tool outcome id");
    }
    if (previous) previous.count++;
    else values.set(id, { text: current, isError, effectiveError, count: 1 });
  };
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const use of message.toolUses ?? []) {
        if (hasOutcome(use)) {
          const outcome = inlineOutcome(use);
          add(use.tool_use_id, outcome.text, outcome.isError, use.tool, outcome.result);
        }
      }
    } else {
      for (const result of message.toolResults ?? []) {
        if (!answered.has(result.tool_use_id)) {
          add(result.tool_use_id, result.text, result.isError, calls.get(result.tool_use_id)?.tool ?? "", result.result);
        }
      }
    }
  }
  return { values, calls };
}

/** An absent result means the rebuilt input conserves the current effective outcomes. */
export function outcomeConservationProblem(current: readonly ClaudeMessage[], rebuilt: readonly ClaudeMessage[]): string | undefined {
  const required = outcomes(current);
  const available = outcomes(rebuilt);
  for (const [id, before] of required.values) {
    const after = available.values.get(id);
    const beforeTool = required.calls.get(id)?.tool;
    const afterTool = available.calls.get(id)?.tool;
    if ((beforeTool !== undefined && afterTool !== undefined && beforeTool !== afterTool)
      || (after && (!sameText(before.text, after.text) || before.isError !== after.isError || before.effectiveError !== after.effectiveError))) {
      return "conflicting tool outcome id";
    }
    const verdict = decide({ required: before.count, available: after?.count ?? 0 });
    if (verdict["out.accepted"] !== 1) return "missing tool outcome in rebuilt input";
    // Without the current call, the compactor cannot attach its result to an operation.
    if (after && beforeTool !== undefined && afterTool === undefined) return "ambiguous tool outcome: rebuilt input has no tool use";
  }
  return undefined;
}
