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
  sourceAvailable: boolean;
}

interface BashEvent extends EventBase {
  kind: "bash";
  toolCallId: string;
  command: string;
  isError: boolean;
  exitCode: number | null;
  error?: string;
  sourceAvailable: boolean;
}

type DistributiveOmit<T, K extends keyof any> = T extends T ? Omit<T, K> : never;

export type CompactionEvent =
  | UserEvent
  | AssistantTextEvent
  | ToolCallEvent
  | ToolResultEvent
  | BashEvent;

export const firstLine = (text: string): string => {
  const trimmed = text.trimStart();
  const nl = trimmed.indexOf("\n");
  return nl < 0 ? trimmed : trimmed.slice(0, nl);
};

export const hasOutcome = (use: ClaudeToolUse): boolean =>
  use.text !== undefined || use.isError === true || use.result !== undefined;

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
  const results = new Map<string, { result: ClaudeToolResult; entryId: string }>();
  messages.forEach((message, position) => {
    for (const result of message.toolResults ?? []) results.set(result.tool_use_id, { result, entryId: String(position) });
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
    sourceAvailable: boolean,
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
        sourceAvailable,
        ...(isError && text ? { error: text } : {}),
      }, entryId);
      return;
    }
    push({ kind: "toolResult", toolCallId, toolName: tool, isError, text, sourceAvailable }, entryId);
  };

  messages.forEach((message, position) => {
    const entryId = String(position);
    if (message.role === "user") {
      if (message.text.trim()) push({ kind: "user", text: message.text }, entryId);
      for (const result of message.toolResults ?? []) {
        if (answered.has(result.tool_use_id)) continue;
        pushResult(result.tool_use_id, calls.get(result.tool_use_id)?.tool ?? "", result.isError, result.text, result.result, entryId, true);
      }
      return;
    }
    if (message.text.trim()) push({ kind: "assistantText", text: message.text }, entryId);
    for (const use of message.toolUses ?? []) {
      push({ kind: "toolCall", toolCallId: use.tool_use_id, name: use.tool, args: use.input ?? {} }, entryId);
      if (!hasOutcome(use)) continue;
      const source = results.get(use.tool_use_id);
      pushResult(use.tool_use_id, use.tool, use.isError === true || source?.result.isError === true,
        source?.result.text ?? use.text ?? "", use.result ?? source?.result.result, source?.entryId ?? entryId, !!source);
    }
  });

  return events;
};
