// The live cut stays untouched. After the summary is accepted, replace only a
// provably text-only whole-file Read result. Handles are opaque, so the original
// transcript must independently identify both the call and the recoverable row.
import { utf8Bytes } from "./bounds.ts";
import type { ClaudeMessage, ClaudeToolUse } from "./from-claude.ts";
import { keptReadStub } from "./verified/generated/kept-read-stub.js";
import { parseTranscript } from "../recall/transcript.ts";

export const READ_STUB_THRESHOLD = 16_384;
export const READ_STUB_MAX_BYTES = 1_024;

type RecordValue = Record<string, unknown>;
const obj = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const blocks = (row: RecordValue): unknown[] => Array.isArray(obj(row.message).content) ? obj(row.message).content as unknown[] : [];
const textOf = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || !content.every((item) => obj(item).type === "text" && typeof obj(item).text === "string"
    && Object.keys(obj(item)).every((key) => key === "type" || key === "text"))) return undefined;
  return content.map((item) => obj(item).text as string).join("\n");
};

interface Candidate { message: ClaudeMessage; use: ClaudeToolUse; callHandle: string; id: string; text: string }

/** Candidates come solely from the already-selected tail, not the summary. */
function candidates(messages: readonly ClaudeMessage[]): Candidate[] {
  const calls = new Map<string, { use: ClaudeToolUse; handle: string; index: number }[]>();
  const resultCounts = new Map<string, number>();
  messages.slice(1).forEach((m, index) => {
    for (const use of m.toolUses ?? []) {
      const matches = calls.get(use.tool_use_id) ?? [];
      if (m.role === "assistant" && m.handle) matches.push({ use, handle: m.handle, index });
      calls.set(use.tool_use_id, matches);
    }
    for (const result of m.toolResults ?? []) resultCounts.set(result.tool_use_id, (resultCounts.get(result.tool_use_id) ?? 0) + 1);
  });
  const found: Candidate[] = [];
  for (const [index, message] of messages.slice(1).entries()) {
    if (message.role !== "user" || message.text !== "" || message.toolUses.length !== 0 || !message.handle
      || /[\r\n]/.test(message.handle) || message.toolResults?.length !== 1) continue;
    const result = message.toolResults[0]!;
    const matches = calls.get(result.tool_use_id) ?? [];
    if (matches.length !== 1 || matches[0]!.index >= index || resultCounts.get(result.tool_use_id) !== 1
      || result.isError || matches[0]!.use.tool !== "Read") continue;
    const { use, handle: callHandle } = matches[0]!;
    const path = use.input.file_path;
    if (typeof path !== "string" || !path || Object.keys(use.input).some((key) => key !== "file_path" && key !== "allow_large")
      || ("allow_large" in use.input && typeof use.input.allow_large !== "boolean")) continue;
    const original = utf8Bytes(result.text);
    const text = `[Whole-file Read text removed: ${original} UTF-8 bytes]\nFile: ${JSON.stringify(path)}\nTranscript entry: ${message.handle}\nRead the file again with Read, or use history.expand with this entry id (get a binding from history.recall).`;
    const facts = { original, stub: utf8Bytes(text), threshold: READ_STUB_THRESHOLD, cap: READ_STUB_MAX_BYTES };
    if (keptReadStub.step({}, keptReadStub.init({}), facts).scalars["out.replace"] !== 1) continue;
    found.push({ message, use, callHandle, id: message.handle, text });
  }
  return found;
}

export const hasKeptReadCandidate = (messages: readonly ClaudeMessage[]): boolean => candidates(messages).length > 0;

/** Only rebuild a row once raw transcript blocks rule out hidden images and other content. */
export function stubKeptReads(messages: readonly ClaudeMessage[], transcript: string): ClaudeMessage[] {
  const planned = candidates(messages);
  if (!planned.length) return [...messages];
  // expand resolves only parseable, non-sidechain transcript entries.
  const parsed = parseTranscript(transcript);
  const needed = new Set(planned.flatMap((item) => [item.id, item.callHandle]));
  const rows = new Map<string, RecordValue>();
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    const row = obj(JSON.parse(line));
    if (row.isSidechain === true || typeof row.uuid !== "string" || !needed.has(row.uuid)) continue;
    rows.set(row.uuid, row);
  }
  const replacements = new Map<ClaudeMessage, string>();
  for (const candidate of planned) {
    const { id, callHandle, use, message, text } = candidate;
    const row = rows.get(id), call = rows.get(callHandle);
    if (!row || !call || row.type !== "user" || call.type !== "assistant") continue;
    const callBlocks = blocks(call).map(obj).filter((b) => b.type === "tool_use" && b.id === use.tool_use_id);
    if (callBlocks.length !== 1 || callBlocks[0]!.name !== "Read" || JSON.stringify(callBlocks[0]!.input) !== JSON.stringify(use.input)) continue;
    const contents = blocks(row);
    if (contents.length !== 1) continue;
    const block = obj(contents[0]), result = message.toolResults![0]!;
    const entry = parsed.byId.get(id);
    if (entry?.kind !== "tool_result" || entry.text !== `toolResult: ${result.text}`) continue;
    if (block.type !== "tool_result" || block.tool_use_id !== result.tool_use_id || block.is_error === true || textOf(block.content) !== result.text
      || Object.keys(block).some((key) => !["type", "tool_use_id", "content", "is_error"].includes(key))) continue;
    const record = obj(row.toolUseResult), file = obj(record.file);
    if (record.type !== "text" || file.startLine !== 1 || typeof file.numLines !== "number" || file.numLines !== file.totalLines) continue;
    replacements.set(message, text);
  }
  return messages.map((message) => {
    const text = replacements.get(message);
    if (text === undefined) return message;
    // A handled message is returned whole by the engine; dropping only its handle
    // tells the engine to construct this verified text-only tool-result row.
    const { handle, ...built } = message;
    void handle;
    return { ...built, toolResults: [{ ...message.toolResults![0]!, text }] };
  });
}
