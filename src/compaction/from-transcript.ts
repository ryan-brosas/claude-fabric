// Transcript JSONL rows use the same ClaudeMessage input as the hook and the compactor.
import { transcriptChain, type TranscriptRow } from "../recall/transcript.ts";
import { isFabricSummary } from "./compact.ts";
import { hasOutcome, type ClaudeMessage, type ClaudeToolUse } from "./from-claude.ts";
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

// Narrow both inputs to one id so the existing conservation check can distinguish a
// shortage from a conflict without letting one missing outcome hide another conflict.
const forTool = (messages: readonly ClaudeMessage[], id: string): ClaudeMessage[] => messages.map((message) => ({
  ...message,
  toolUses: message.toolUses.filter((use) => use.tool_use_id === id),
  toolResults: (message.toolResults ?? []).filter((result) => result.tool_use_id === id),
}));

type Call = { index: number; use: ClaudeToolUse };

type SiblingContext = {
  current: readonly ClaudeMessage[]; dropped: readonly ClaudeMessage[]; rebuilt: ClaudeMessage[];
  prefixLength: number; chain: TranscriptRow[]; calls: Map<string, Call[]>;
  currentCalls: Map<string, ClaudeToolUse[]>; eligible: Map<string, Call>;
};
type Addition = { message: ClaudeMessage; at: number };

/** Place complete current result rows around results already present in the chain. */
function siblingAdditions(context: SiblingContext): { additions: Addition[]; resultPositions: Map<string, number[]> } | undefined {
  const { current, dropped, rebuilt, prefixLength, chain, calls, currentCalls, eligible } = context;
  const rows = new Map<string, TranscriptRow>();
  for (const row of chain) if (typeof row.uuid === "string") rows.set(row.uuid, row);
  const groupEnd = (index: number): number => {
    const id = string(object(rows.get(rebuilt[index]!.uuid ?? "")?.message).id);
    if (!id) return index;
    while (index + 1 < prefixLength && rebuilt[index + 1]!.role === "assistant"
      && string(object(rows.get(rebuilt[index + 1]!.uuid ?? "")?.message).id) === id) index++;
    return index;
  };
  const resultPositions = new Map<string, number[]>();
  for (const [index, message] of rebuilt.entries()) for (const result of message.toolResults ?? []) {
    const list = resultPositions.get(result.tool_use_id) ?? [];
    list.push(index);
    resultPositions.set(result.tool_use_id, list);
  }
  const addresses = new Map<string, number>();
  for (const message of current) {
    const address = message.handle ?? message.uuid;
    if (address) addresses.set(address, (addresses.get(address) ?? 0) + 1);
  }
  const candidates: Addition[] = [];
  for (const [position, message] of dropped.entries()) {
    const results = message.toolResults ?? [];
    // A partial row could keep a handle for different content. Restore whole rows only.
    if (message.role !== "user" || message.text || message.toolUses.length || !results.length
      || addresses.get(message.handle ?? message.uuid ?? "") !== 1
      || results.some((result) => !eligible.has(result.tool_use_id))) continue;
    const groups = new Set(results.map((result) => groupEnd(eligible.get(result.tool_use_id)!.index)));
    if (groups.size !== 1) continue;
    const group = [...groups][0]!;
    let after = group + 1, before = prefixLength;
    for (const [otherPosition, other] of dropped.entries()) for (const result of other.toolResults ?? []) {
      const call = calls.get(result.tool_use_id);
      const locations = resultPositions.get(result.tool_use_id) ?? [];
      if (call?.length !== 1 || groupEnd(call[0]!.index) !== group || locations.length !== 1) continue;
      const location = locations[0]!;
      if (location <= group || location > prefixLength) continue;
      if (otherPosition < position) after = Math.max(after, location + 1);
      if (otherPosition > position) before = Math.min(before, location);
    }
    if (after <= before && after <= prefixLength) candidates.push({ message, at: after });
  }

  // Do not guess which occurrence a transcript row represents. If there is already
  // an outcome, only restore a known shortage when all dropped occurrences are needed.
  for (const id of eligible.keys()) {
    const available = (resultPositions.get(id) ?? []).length;
    if (!available) continue;
    const currentUse = currentCalls.get(id)?.[0];
    const required = currentUse && hasOutcome(currentUse) ? 1 : current.reduce((n, message) =>
      n + (message.toolResults ?? []).filter((result) => result.tool_use_id === id).length, 0);
    const missing = candidates.reduce((n, candidate) => n
      + (candidate.message.toolResults ?? []).filter((result) => result.tool_use_id === id).length, 0);
    if (required - available !== missing) eligible.delete(id);
  }
  const additions = candidates.filter(({ message }) => message.toolResults!.every((result) => eligible.has(result.tool_use_id)));
  // If current ordering disagrees with the chain, refuse rather than reorder outcomes.
  if (additions.some((item, index) => index > 0 && item.at < additions[index - 1]!.at)) return undefined;
  return { additions, resultPositions };
}

/** Restore only current outcomes whose unique call is in the raw prefix. */
function restoreOutcomes(current: readonly ClaudeMessage[], summary: number, join: number,
  prefixLength: number, rebuilt: ClaudeMessage[], chain: TranscriptRow[]): ClaudeMessage[] {
  if (outcomeConservationProblem(current, rebuilt) !== MISSING_OUTCOME) return rebuilt;

  const calls = new Map<string, Call[]>();
  for (const [index, message] of rebuilt.entries()) for (const use of message.toolUses) {
    const list = calls.get(use.tool_use_id) ?? [];
    list.push({ index, use });
    calls.set(use.tool_use_id, list);
  }
  const currentCalls = new Map<string, ClaudeToolUse[]>();
  for (const message of current) for (const use of message.toolUses) {
    const list = currentCalls.get(use.tool_use_id) ?? [];
    list.push(use);
    currentCalls.set(use.tool_use_id, list);
  }
  const dropped = current.slice(summary + 1, join);
  const ids = new Set(dropped.flatMap((message) => [
    ...(message.toolResults ?? []).map((result) => result.tool_use_id),
    ...message.toolUses.filter(hasOutcome).map((use) => use.tool_use_id),
  ]));
  const eligible = new Map<string, Call>();
  for (const id of ids) {
    const matches = calls.get(id) ?? [];
    const original = currentCalls.get(id) ?? [];
    if (!id || matches.length !== 1 || matches[0]!.index >= prefixLength || original.length > 1) continue;
    const call = matches[0]!;
    if (original[0] && (original[0].tool !== call.use.tool
      || JSON.stringify(original[0].input) !== JSON.stringify(call.use.input))) continue;
    if (outcomeConservationProblem(forTool(current, id), forTool(rebuilt, id)) === MISSING_OUTCOME) eligible.set(id, call);
  }

  const placement = siblingAdditions({ current, dropped, rebuilt, prefixLength, chain, calls, currentCalls, eligible });
  if (!placement) return rebuilt;
  const { additions, resultPositions } = placement;
  const resultIds = new Set(dropped.flatMap((message) => (message.toolResults ?? []).map((result) => result.tool_use_id)));

  // If there is no result row at all, keep the current inline outcome on the
  // original call. Never let it suppress a conflicting transcript result.
  const withInline = rebuilt.slice();
  for (const [id, call] of eligible) {
    const use = currentCalls.get(id)?.[0];
    if (!use || !hasOutcome(use) || resultIds.has(id) || (resultPositions.get(id)?.length ?? 0) > 0) continue;
    const message = withInline[call.index]!;
    withInline[call.index] = { ...message, toolUses: message.toolUses.map((entry) => entry === call.use ? { ...use } : entry) };
  }
  const output: ClaudeMessage[] = [];
  for (let index = 0; index <= withInline.length; index++) {
    for (const addition of additions) if (addition.at === index) output.push(addition.message);
    if (index < withInline.length) output.push(withInline[index]!);
  }
  return output;
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
