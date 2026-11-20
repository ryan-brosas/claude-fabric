import { expect, test } from "bun:test";
import { fromTranscript } from "../../src/compaction/from-transcript.ts";
import { normalizeMessages } from "../../src/compaction/from-claude.ts";

test("transcript rows preserve Claude text, tool uses, results and errors for the compactor", () => {
  const user = fromTranscript({ type: "user", uuid: "u1", message: { content: "Read the note." } });
  const assistant = fromTranscript({ type: "assistant", uuid: "a1", message: { content: [
    { type: "text", text: "Opening." },
    { type: "thinking", thinking: "not part of the message" },
    { type: "text", text: "Checking." },
    { type: "tool_use", id: "r1", name: "Read", input: { file_path: "note.txt" } },
    { type: "tool_use", id: "b1", name: "Bash", input: { command: "false" } },
  ] } });
  const readResult = fromTranscript({ type: "user", uuid: "r1-row", message: { content: [
    { type: "text", text: "Done reading." },
    { type: "tool_result", tool_use_id: "r1", content: [{ type: "text", text: "α" }, { type: "image" }, { type: "text", text: "β" }] },
  ] } });
  const failed = fromTranscript({ type: "user", uuid: "b1-row", toolUseResult: { exitCode: 1 }, message: { content: [
    { type: "tool_result", tool_use_id: "b1", content: "command failed", is_error: true },
  ] } });

  expect(user).toEqual({ role: "user", text: "Read the note.", toolUses: [], uuid: "u1" });
  expect(assistant).toEqual({ role: "assistant", text: "Opening.\nChecking.", uuid: "a1", toolUses: [
    { tool_use_id: "r1", tool: "Read", input: { file_path: "note.txt" } },
    { tool_use_id: "b1", tool: "Bash", input: { command: "false" } },
  ] });
  expect(readResult).toEqual({ role: "user", text: "Done reading.", toolUses: [], uuid: "r1-row", toolResults: [
    { tool_use_id: "r1", text: "α\nβ", isError: false },
  ] });
  expect(failed.toolResults).toEqual([{ tool_use_id: "b1", text: "command failed", isError: true, result: { exitCode: 1 } }]);
  const events = normalizeMessages([user, assistant, readResult, failed]);
  expect(events.find((event) => event.kind === "toolResult")).toMatchObject({
    kind: "toolResult", toolName: "Read", toolCallId: "r1", text: "α\nβ", isError: false,
  });
  expect(events.find((event) => event.kind === "bash")).toMatchObject({
    kind: "bash", command: "false", isError: true, exitCode: 1, error: "command failed",
  });
});

test("the converter rejects a row that cannot be addressed", () => {
  expect(() => fromTranscript({ type: "system", uuid: "boundary" })).toThrow("no role or uuid");
  expect(() => fromTranscript({ type: "user", message: { content: "missing id" } })).toThrow("no role or uuid");
});
