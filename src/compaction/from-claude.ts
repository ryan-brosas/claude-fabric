// Claude Code's transcript as the typed event stream the summary folds over. Replaces
// pi-fabric's normalize.ts: SessionMessage[] -> CompactionEvent[], with the Pi-only
// events dropped. Only structure is read (roles, tool names, JSON input, isError,
// exit codes); prose is never parsed for structure.
import { utf8Bytes } from "./bounds.ts";

export interface ClaudeToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: true;
  result?: unknown;
}

export interface ClaudeToolResult {
  tool_use_id: string;
  text: string;
  isError: boolean;
  result?: unknown;
}

/** One row of the transcript a session.compact hook receives. */
export interface ClaudeMessage {
  role: "user" | "assistant";
  text: string;
  toolUses: ClaudeToolUse[];
  toolResults?: ClaudeToolResult[];
  uuid?: string;
  /** The engine's opaque token; a kept message goes back up with it. */
  handle?: string;
}

interface EventBase {
  index: number;
  entryId: string;
  sourceEntryId: string;
}

interface UserEvent extends EventBase {
  kind: "user";
  text: string;
}

interface AssistantTextEvent extends EventBase {
  kind: "assistantText";
  text: string;
}

export interface ToolCallEvent extends EventBase {
  kind: "toolCall";
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

interface ToolResultEvent extends EventBase {
  kind: "toolResult";
  toolCallId: string;
  toolName: string;
  isError: boolean;
  text: string;
}

interface BashEvent extends EventBase {
  kind: "bash";
  toolCallId: string;
  command: string;
  isError: boolean;
  exitCode: number | null;
  error?: string;
}

type DistributiveOmit<T, K extends keyof any> = T extends T ? Omit<T, K> : never;

export type CompactionEvent =
  | UserEvent
  | AssistantTextEvent
  | ToolCallEvent
  | ToolResultEvent
  | BashEvent;

type ToolClaim = { call: ClaudeToolUse; outcome?: ClaudeToolResult };

// Both retry readers use a generic JSON argument key except for Bash and file
// tools with a usable path (projections.ts and qa-history.ts). Keep this boundary
// aligned with those readers; their retry behavior must not change here.
const FILE_RETRY_TOOLS = new Set(["Read", "Write", "Edit", "Grep", "Glob"]);
const readsArgumentOrder = (call: ClaudeToolUse): boolean => {
  if (call.tool === "Bash") return false;
  const path = call.input.file_path ?? call.input.path ?? call.input.dir;
  return !(FILE_RETRY_TOOLS.has(call.tool) && typeof path === "string" && !!path.trim());
};

/** Equality on normalized events and the other fields compaction readers observe. */
export function sameToolClaim(left: ToolClaim, right: ToolClaim): boolean {
  const events = ({ call, outcome }: ToolClaim) => {
    const use = { tool_use_id: call.tool_use_id, tool: call.tool, input: call.input };
    const messages: ClaudeMessage[] = [{ role: "assistant", text: "", toolUses: [use] }];
    if (outcome) messages.push({ role: "user", text: "", toolUses: [], toolResults: [outcome] });
    return normalizeMessages(messages).map(({ index, entryId, sourceEntryId, ...event }) => event);
  };
  const equal = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => equal(value, b[i]));
    }
    const first = a as Record<string, unknown>, second = b as Record<string, unknown>;
    const keys = Object.keys(first);
    return keys.length === Object.keys(second).length
      && keys.every((key) => Object.prototype.hasOwnProperty.call(second, key) && equal(first[key], second[key]));
  };
  return equal(events(left), events(right))
    && summarizeToolArgs(left.call.tool, left.call.input) === summarizeToolArgs(right.call.tool, right.call.input)
    && (!readsArgumentOrder(left.call) || JSON.stringify(left.call.input) === JSON.stringify(right.call.input))
    && left.outcome?.text === right.outcome?.text
    && left.outcome?.isError === right.outcome?.isError;
}
export const firstLine = (text: string): string => {
  const trimmed = text.trimStart();
  const nl = trimmed.indexOf("\n");
  return nl < 0 ? trimmed : trimmed.slice(0, nl);
};

// Shared with the transcript projection: comparison must see exactly what it renders.
export const MAX_TRANSCRIPT_CMD = 80;
export const summarizeToolArgs = (name: string, args: Record<string, unknown>): string => {
  const truncate = (text: string, max: number): string => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  };
  const path = args.file_path ?? args.path ?? args.dir;
  const primary = name === "Bash" ? args.command ?? args.cmd ?? args.shell
    : name === "Grep" ? args.pattern ?? args.query ?? args.regex
    : name === "Glob" ? args.pattern
    : typeof path === "string" && path.trim() ? path : undefined;
  if (typeof primary === "string" && primary.trim()) return truncate(firstLine(primary), MAX_TRANSCRIPT_CMD);
  return Object.entries(args).slice(0, 2).map(([key, value]) => `${key}=${truncate(String(value), 40)}`).join(" ");
};
export const hasOutcome = (use: ClaudeToolUse): boolean =>
  use.text !== undefined || use.isError === true || use.result !== undefined;

/** The hook’s inline outcome is authoritative when present, even if a row differs. */
export const inlineOutcome = (use: ClaudeToolUse): { text: string; isError: boolean; result: unknown } =>
  ({ text: use.text ?? "", isError: use.isError === true, result: use.result });

export const exitCodeOf = (result: unknown): number | null => {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  const value = record.exitCode ?? record.exit_code;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
};

const commandOf = (use: ClaudeToolUse | undefined): string =>
  typeof use?.input.command === "string" ? use.input.command : "";

/** A read-only view a transcript needs, in bytes; one token is about four bytes. */
export const messageBytes = (message: ClaudeMessage): number =>
  utf8Bytes(message.text)
  + (message.toolUses ?? []).reduce((sum, use) =>
    sum + utf8Bytes(use.tool) + utf8Bytes(JSON.stringify(use.input ?? {})) + utf8Bytes(use.text ?? ""), 0)
  + (message.toolResults ?? []).reduce((sum, result) => sum + utf8Bytes(result.text), 0);

/**
 * Flatten one transcript into events. A tool result arrives either on the
 * assistant's tool_use (its stored outcome) or as a user row's tool_result,
 * never both: an id answered on the tool_use is skipped where it repeats.
 */
export const normalizeMessages = (messages: readonly ClaudeMessage[]): CompactionEvent[] => {
  const events: CompactionEvent[] = [];
  let index = 0;
  const push = (event: DistributiveOmit<CompactionEvent, "index" | "entryId" | "sourceEntryId">, entryId: string): void => {
    index += 1;
    events.push({ ...event, index, entryId, sourceEntryId: entryId } as CompactionEvent);
  };

  const calls = new Map<string, ClaudeToolUse>();
  const answered = new Set<string>();
  const results = new Map<string, Map<string, string>>();
  messages.forEach((message, position) => {
    for (const result of message.toolResults ?? []) {
      const texts = results.get(result.tool_use_id) ?? new Map<string, string>();
      texts.set(result.text, String(position));
      results.set(result.tool_use_id, texts);
    }
  });
  for (const message of messages) {
    for (const use of message.toolUses ?? []) {
      calls.set(use.tool_use_id, use);
      if (hasOutcome(use)) answered.add(use.tool_use_id);
    }
  }

  const pushResult = (
    toolCallId: string,
    tool: string,
    isError: boolean,
    text: string,
    result: unknown,
    entryId: string,
  ): void => {
    if (tool === "Bash") {
      const use = calls.get(toolCallId);
      const exitCode = exitCodeOf(result ?? use?.result);
      push({
        kind: "bash",
        toolCallId,
        command: commandOf(use),
        isError: isError || (exitCode !== null && exitCode !== 0),
        exitCode,
        ...(isError && text ? { error: text } : {}),
      }, entryId);
      return;
    }
    push({ kind: "toolResult", toolCallId, toolName: tool, isError, text }, entryId);
  };

  messages.forEach((message, position) => {
    const entryId = String(position);
    if (message.role === "user") {
      if (message.text.trim()) push({ kind: "user", text: message.text }, entryId);
      for (const result of message.toolResults ?? []) {
        if (answered.has(result.tool_use_id)) continue;
        pushResult(result.tool_use_id, calls.get(result.tool_use_id)?.tool ?? "", result.isError, result.text, result.result, entryId);
      }
      return;
    }
    if (message.text.trim()) push({ kind: "assistantText", text: message.text }, entryId);
    for (const use of message.toolUses ?? []) {
      push({ kind: "toolCall", toolCallId: use.tool_use_id, name: use.tool, args: use.input ?? {} }, entryId);
      if (!hasOutcome(use)) continue;
      const outcome = inlineOutcome(use);
      // A row can address an excerpt only when it contains the inline body.
      const source = results.get(use.tool_use_id)?.get(outcome.text);
      pushResult(use.tool_use_id, use.tool, outcome.isError, outcome.text, outcome.result, source ?? entryId);
    }
  });

  return events;
};
