import { expect, test } from "bun:test";
import { fromTranscript, rebuildTranscript } from "../../src/compaction/from-transcript.ts";
import { outcomeConservationProblem } from "../../src/compaction/outcome-conservation.ts";
import type { ClaudeMessage } from "../../src/compaction/from-claude.ts";
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

const summary: ClaudeMessage = { role: "user", text: "[Fabric summary]\nold", toolUses: [], handle: "summary" };
const userMessage = (handle: string, text = ""): ClaudeMessage => ({ role: "user", text, toolUses: [], handle });
const toolUse = (id: string) => ({ tool_use_id: id, tool: "Read", input: { file_path: `${id}.txt` } });
const resultMessage = (handle: string, id: string, text: string, isError = false): ClaudeMessage =>
  ({ ...userMessage(handle), toolResults: [{ tool_use_id: id, text, isError }] });
const callMessage = (handle: string, id: string): ClaudeMessage =>
  ({ role: "assistant", text: "", toolUses: [toolUse(id)], handle });
const transcript = (...rows: object[]) => rows.map((row) => JSON.stringify(row)).join("\n");
const promptRow = (uuid: string, parentUuid: string | null) =>
  ({ type: "user", uuid, parentUuid, message: { content: uuid } });
const callRow = (uuid: string, parentUuid: string, id: string, messageId = "parallel") =>
  ({ type: "assistant", uuid, parentUuid, message: { id: messageId, content: [
    { type: "tool_use", id, name: "Read", input: { file_path: `${id}.txt` } },
  ] } });
const resultRow = (uuid: string, parentUuid: string, id: string, text: string, isError = false) =>
  ({ type: "user", uuid, parentUuid, message: { content: [
    { type: "tool_result", tool_use_id: id, content: text, is_error: isError },
  ] } });

test("restores current sibling result rows in order with addresses, multiplicity and error status", () => {
  // Separate assistant rows share a message id, as in the recorded parallel call.
  const a = callMessage("copy-a", "a"), c = callMessage("copy-c", "c"), b = callMessage("copy-b", "b");
  const first = resultMessage("sibling-a1", "a", "FAILED", true);
  const duplicate = resultMessage("sibling-a2", "a", "FAILED", true);
  const second = resultMessage("sibling-c", "c", "OTHER");
  const joined = resultMessage("joined", "b", "ON-CHAIN");
  const last = userMessage("last", "next");
  const current = [summary, a, c, b, first, duplicate, second, joined, last];
  const text = transcript(promptRow("start", null), callRow("call-a", "start", "a"),
    callRow("call-c", "call-a", "c"), callRow("call-b", "call-c", "b"),
    resultRow("sibling-a1", "call-a", "a", "FAILED", true),
    resultRow("sibling-a2", "call-a", "a", "FAILED", true),
    resultRow("sibling-c", "call-c", "c", "OTHER"),
    resultRow("joined", "call-b", "b", "ON-CHAIN"), promptRow("last", "joined"));
  const rebuilt = rebuildTranscript(current, text);
  expect(rebuilt.map((message) => message.handle ?? message.uuid)).toEqual([
    "start", "call-a", "call-c", "call-b", "sibling-a1", "sibling-a2", "sibling-c", "joined", "last",
  ]);
  expect(rebuilt.slice(4, 7)).toEqual([first, duplicate, second]);
  expect(rebuilt.slice(4, 7)).toHaveLength(3);
  expect(outcomeConservationProblem(current, rebuilt)).toBeUndefined();
});

test("restores an inline-only outcome on the unique active-chain call", () => {
  const call = callMessage("copy-a", "a");
  call.toolUses[0] = { ...call.toolUses[0]!, text: "INLINE-ONLY", isError: true };
  const joined = userMessage("joined", "next");
  const current = [summary, call, joined];
  const rebuilt = rebuildTranscript(current, transcript(promptRow("start", null), callRow("call-a", "start", "a"),
    promptRow("joined", "call-a")));
  expect(rebuilt.find((message) => message.uuid === "call-a")?.toolUses[0]).toMatchObject({
    tool_use_id: "a", text: "INLINE-ONLY", isError: true,
  });
  expect(outcomeConservationProblem(current, rebuilt)).toBeUndefined();
});

test("an outcome with no active-chain call is not restored", () => {
  const call = callMessage("copy-a", "a");
  const orphan = resultMessage("off-chain", "a", "ORPHAN", true);
  const joined = userMessage("joined", "next");
  const current = [summary, call, orphan, joined];
  const rebuilt = rebuildTranscript(current, transcript(promptRow("start", null),
    callRow("off-chain-call", "start", "a"), resultRow("off-chain", "off-chain-call", "a", "ORPHAN", true),
    promptRow("joined", "start")));
  expect(rebuilt.some((message) => message.handle === "off-chain")).toBe(false);
  expect(outcomeConservationProblem(current, rebuilt)).toBe("missing tool outcome in rebuilt input");
});

test("a conflicting result is not covered up by an inline outcome", () => {
  const call = callMessage("copy-a", "a");
  call.toolUses[0] = { ...call.toolUses[0]!, text: "CURRENT", isError: true };
  const joined = userMessage("joined", "next");
  const current = [summary, call, joined];
  const rebuilt = rebuildTranscript(current, transcript(promptRow("start", null), callRow("call-a", "start", "a"),
    resultRow("answer", "call-a", "a", "DIFFERENT", true), promptRow("joined", "answer")));
  expect(outcomeConservationProblem(current, rebuilt)).toBe("conflicting tool outcome id");
});

test("an ambiguous repeated active-chain call is not used to restore a sibling", () => {
  const call = callMessage("copy-a", "a");
  const result = resultMessage("sibling", "a", "ANSWER");
  const joined = userMessage("joined", "next");
  const current = [summary, call, result, joined];
  const rebuilt = rebuildTranscript(current, transcript(promptRow("start", null), callRow("call-a1", "start", "a"),
    callRow("call-a2", "call-a1", "a"), resultRow("sibling", "call-a1", "a", "ANSWER"),
    promptRow("joined", "call-a2")));
  expect(rebuilt.some((message) => message.handle === "sibling")).toBe(false);
  expect(outcomeConservationProblem(current, rebuilt)).toBe("missing tool outcome in rebuilt input");
});

test("a restored sibling stays after an earlier result already in the chain", () => {
  const a = callMessage("copy-a", "a"), b = callMessage("copy-b", "b");
  const earlier = resultMessage("copy-result-a", "a", "FIRST");
  const sibling = resultMessage("sibling-b", "b", "SECOND", true);
  const joined = userMessage("joined", "next");
  const current = [summary, a, b, earlier, sibling, joined];
  const rebuilt = rebuildTranscript(current, transcript(promptRow("start", null), callRow("call-a", "start", "a"),
    callRow("call-b", "call-a", "b"), resultRow("result-a", "call-b", "a", "FIRST"),
    resultRow("sibling-b", "call-b", "b", "SECOND", true), promptRow("joined", "result-a")));
  expect(rebuilt.map((message) => message.handle ?? message.uuid)).toEqual([
    "start", "call-a", "call-b", "result-a", "sibling-b", "joined",
  ]);
  expect(outcomeConservationProblem(current, rebuilt)).toBeUndefined();
});

test("restoring a shortage cannot hide a different conflicting outcome", () => {
  const a = callMessage("copy-a", "a"), b = callMessage("copy-b", "b");
  b.toolUses[0] = { ...b.toolUses[0]!, text: "CURRENT-B", isError: true };
  const sibling = resultMessage("sibling-a", "a", "MISSING-A");
  const joined = userMessage("joined", "next");
  const current = [summary, a, b, sibling, joined];
  const rebuilt = rebuildTranscript(current, transcript(promptRow("start", null), callRow("call-a", "start", "a"),
    callRow("call-b", "call-a", "b"), resultRow("sibling-a", "call-a", "a", "MISSING-A"),
    resultRow("answer-b", "call-b", "b", "WRONG-B", true), promptRow("joined", "answer-b")));
  expect(outcomeConservationProblem(current, rebuilt)).toBe("conflicting tool outcome id");
});

test("reused sibling addresses are ambiguous and are not restored", () => {
  const call = callMessage("copy-a", "a");
  const result = resultMessage("same-address", "a", "ANSWER");
  const joined = userMessage("joined", "next");
  const current = [summary, call, result, { ...result }, joined];
  const rebuilt = rebuildTranscript(current, transcript(promptRow("start", null), callRow("call-a", "start", "a"),
    resultRow("same-address", "call-a", "a", "ANSWER"), promptRow("joined", "call-a")));
  expect(rebuilt.some((message) => message.handle === "same-address")).toBe(false);
  expect(outcomeConservationProblem(current, rebuilt)).toBe("missing tool outcome in rebuilt input");
});

test("the converter rejects a row that cannot be addressed", () => {
  expect(() => fromTranscript({ type: "system", uuid: "boundary" })).toThrow("no role or uuid");
  expect(() => fromTranscript({ type: "user", message: { content: "missing id" } })).toThrow("no role or uuid");
});
