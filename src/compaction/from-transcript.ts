// Transcript JSONL rows use the same ClaudeMessage input as the hook and the compactor.
import { transcriptChain, type TranscriptRow } from "../recall/transcript.ts";
import { isFabricSummary } from "./compact.ts";
import { exitCodeOf, hasOutcome, inlineOutcome, normalizeMessages, type ClaudeMessage, type ClaudeToolResult, type ClaudeToolUse } from "./from-claude.ts";
import { outcomeRestoration } from "./verified/generated/outcome-restoration.js";
import { outcomeConservationProblem } from "./outcome-conservation.ts";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(object).filter((part) => part.type === "text").map((part) => string(part.text)).join("\n");
};

/** Convert one user or assistant transcript row to the compactor's message shape. */
export function fromTranscript(row: TranscriptRow): ClaudeMessage {
  if ((row.type !== "user" && row.type !== "assistant") || typeof row.uuid !== "string" || !row.uuid) {
    throw new Error("fabric: transcript conversation row has no role or uuid");
  }
  const content = object(row.message).content;
  const parts = Array.isArray(content) ? content.map(object) : [];
  const toolUses: ClaudeMessage["toolUses"] = [];
  const toolResults: NonNullable<ClaudeMessage["toolResults"]> = [];
  for (const block of parts) {
    if (block.type === "tool_use") {
      toolUses.push({ tool_use_id: string(block.id), tool: string(block.name), input: object(block.input) });
    } else if (block.type === "tool_result") {
      toolResults.push({ tool_use_id: string(block.tool_use_id), text: textOf(block.content),
        isError: block.is_error === true, ...(row.toolUseResult === undefined ? {} : { result: row.toolUseResult }) });
    }
  }
  return { role: row.type, text: textOf(content), toolUses,
    ...(toolResults.length ? { toolResults } : {}), uuid: row.uuid };
}

const MISSING_OUTCOME = "missing tool outcome in rebuilt input";

// Current outcomes must appear in order. The raw prefix may already contain
// additional outcomes for a non-deficit call, which restoration leaves alone.
function sameCurrentOrder(current: readonly ClaudeMessage[], rebuilt: readonly ClaudeMessage[]): boolean {
  const ids = (messages: readonly ClaudeMessage[]) => normalizeMessages(messages).flatMap((event) =>
    event.kind === "toolResult" || event.kind === "bash" ? [event.toolCallId] : []);
  const expected = ids(current);
  let next = 0;
  for (const id of ids(rebuilt)) if (id === expected[next]) next++;
  return next === expected.length;
}

// Count the effective outcomes the compactor sees, not duplicate inline/row copies.
function outcomeCounts(messages: readonly ClaudeMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of normalizeMessages(messages)) {
    if (event.kind === "toolResult" || event.kind === "bash") {
      counts.set(event.toolCallId, (counts.get(event.toolCallId) ?? 0) + 1);
    }
  }
  return counts;
}

// Compare the authoritative inline outcome with the row as the rebuilt call
// will normalize it, including a Bash exit code that makes a result an error.
function matchesInline(original: ClaudeToolUse | undefined, call: ClaudeToolUse, result: ClaudeToolResult): boolean {
  if (!original || !hasOutcome(original)) return true;
  const inline = inlineOutcome(original);
  const isError = (error: boolean, value: unknown): boolean => {
    const exit = original.tool === "Bash" ? exitCodeOf(value) : null;
    return error || (exit !== null && exit !== 0);
  };
  return inline.text === result.text && inline.isError === result.isError
    && isError(inline.isError, inline.result) === isError(result.isError, result.result ?? call.result);
}
/** Restore only whole sibling result rows from the terminal parallel group. */
function restoreOutcomes(current: readonly ClaudeMessage[], summary: number, join: number,
  prefixLength: number, rebuilt: ClaudeMessage[], chain: TranscriptRow[]): ClaudeMessage[] {
  if (outcomeConservationProblem(current, rebuilt) !== MISSING_OUTCOME || !prefixLength) return rebuilt;

  const rows = new Map(chain.map((row) => [row.uuid, row]));
  const messageId = (message: ClaudeMessage): string => string(object(rows.get(message.uuid)?.message).id);
  const last = rebuilt[prefixLength - 1]!;
  const id = last.role === "assistant" ? messageId(last) : "";
  if (!id) return rebuilt;
  let start = prefixLength - 1;
  while (start > 0 && rebuilt[start - 1]!.role === "assistant" && messageId(rebuilt[start - 1]!) === id) start--;
  if (prefixLength - start < 2) return rebuilt;
  const calls = new Map<string, ClaudeToolUse>();
  for (const use of rebuilt.slice(start, prefixLength).flatMap((message) => message.toolUses)) {
    if (!use.tool_use_id || calls.has(use.tool_use_id)) return rebuilt;
    calls.set(use.tool_use_id, use);
  }
  const joined = rebuilt[prefixLength]!;
  if (joined.role !== "user" || !joined.toolResults?.some((result) => calls.has(result.tool_use_id))) return rebuilt;

  const required = outcomeCounts(current), existing = outcomeCounts(rebuilt);
  const deficits = new Set([...required].filter(([toolId, count]) => (existing.get(toolId) ?? 0) < count).map(([toolId]) => toolId));
  const allUses = rebuilt.flatMap((message) => message.toolUses);
  const currentUses = current.flatMap((message) => message.toolUses);
  const addresses = new Map<string, number>();
  for (const message of current) {
    const address = message.handle ?? message.uuid;
    if (address) addresses.set(address, (addresses.get(address) ?? 0) + 1);
  }
  const candidates = new Set<ClaudeMessage>();
  for (const toolId of deficits) {
    const call = calls.get(toolId);
    if (!toolId || !call || allUses.filter((use) => use.tool_use_id === toolId).length !== 1) return rebuilt;
    const originals = currentUses.filter((use) => use.tool_use_id === toolId);
    if (originals.length > 1 || originals.some((use) => use.tool !== call.tool
      || JSON.stringify(use.input) !== JSON.stringify(call.input))) return rebuilt;
    const occurrences = current.flatMap((message, index) => (message.toolResults ?? [])
      .filter((result) => result.tool_use_id === toolId).map((result) => ({ message, index, result })));
    if (occurrences.length !== 1) return rebuilt;
    const { message, index, result } = occurrences[0]!;
    const address = message.handle ?? message.uuid;
    if (index <= summary || index >= join || message.role !== "user" || message.text || message.toolUses.length
      || !address || addresses.get(address) !== 1 || rebuilt.some((row) => (row.handle ?? row.uuid) === address)
      || message.toolResults!.some((entry) => !deficits.has(entry.tool_use_id))) return rebuilt;
    if (!matchesInline(originals[0], call, result)) return rebuilt;
    const verdict = outcomeRestoration.step({}, outcomeRestoration.init({}), {
      required: required.get(toolId)!, existing: existing.get(toolId) ?? 0, restored: 1,
    });
    if (verdict.scalars["out.admitted"] !== 1) return rebuilt;
    candidates.add(message);
  }
  if (!candidates.size) return rebuilt;
  const additions = current.slice(summary + 1, join).filter((message) => candidates.has(message));
  const output = [...rebuilt.slice(0, prefixLength), ...additions, ...rebuilt.slice(prefixLength)];
  return sameCurrentOrder(current, output) ? output : rebuilt;
}

/** Rebuild only before the first current handle found on the active chain. */
export function rebuildTranscript(messages: readonly ClaudeMessage[], text: string): ClaudeMessage[] {
  const summary = messages.findIndex(isFabricSummary);
  if (summary < 0) throw new Error("fabric: no earlier Fabric summary to rebuild");
  const { chain } = transcriptChain(text);
  const positions = new Map<string, number>();
  chain.forEach((row, index) => {
    if ((row.type === "user" || row.type === "assistant") && typeof row.uuid === "string") positions.set(row.uuid, index);
  });
  const join = messages.findIndex((message, index) => index > summary && !!message.handle && positions.has(message.handle));
  if (join < 0) throw new Error("fabric: no current message handle joins the transcript chain");
  const chainEnd = positions.get(messages[join]!.handle!)!;
  const prefix = chain.slice(0, chainEnd)
    .filter((row) => row.type === "user" || row.type === "assistant")
    .map(fromTranscript)
    .filter((message) => !isFabricSummary(message));
  const rebuilt = [...prefix, ...messages.slice(join).filter((message) => !isFabricSummary(message))];
  return restoreOutcomes(messages, summary, join, prefix.length, rebuilt, chain);
}
