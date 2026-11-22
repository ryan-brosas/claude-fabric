import type { TranscriptRow } from "../recall/transcript.ts";
import type { ClaudeMessage } from "./from-claude.ts";

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
