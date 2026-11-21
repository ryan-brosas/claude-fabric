import { expect, test } from "bun:test";
import { fromTranscript, rebuildTranscript } from "../../src/compaction/from-transcript.ts";
import { outcomeConservationProblem } from "../../src/compaction/outcome-conservation.ts";
import type { ClaudeMessage } from "../../src/compaction/from-claude.ts";
import { normalizeMessages } from "../../src/compaction/from-claude.ts";
import { projectOutstanding } from "../../src/compaction/projections.ts";

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

test("refuses repeated outcomes but restores one row per sibling in order with addresses and errors", () => {
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
  expect(rebuilt.some((message) => message.handle === "sibling-a1" || message.handle === "sibling-c")).toBe(false);
  expect(outcomeConservationProblem(current, rebuilt)).toBe("missing tool outcome in rebuilt input");

  // The narrowed rule admits exactly one missing effective outcome per call.
  const oneEach = [summary, a, c, b, first, second, joined, last];
  const restored = rebuildTranscript(oneEach, text);
  expect(restored.map((message) => message.handle ?? message.uuid)).toEqual([
    "start", "call-a", "call-c", "call-b", "sibling-a1", "sibling-c", "joined", "last",
  ]);
  expect(restored.slice(4, 6)).toEqual([first, second]);
  expect(restored.slice(4, 6)).toHaveLength(2);
  expect(restored[4]).toBe(first);
  expect(restored[4]!.toolResults![0]!.isError).toBe(true);
  expect(outcomeConservationProblem(oneEach, restored)).toBeUndefined();
});

test("restores a matching inline sibling while leaving an earlier non-deficit result alone", () => {
  const earlier = callMessage("copy-earlier", "earlier");
  earlier.toolUses[0] = { ...earlier.toolUses[0]!, text: "EARLIER" };
  const earlierResult = resultMessage("copy-earlier-result", "earlier", "EARLIER");
  const a = callMessage("copy-a", "a"), b = callMessage("copy-b", "b");
  a.toolUses[0] = { ...a.toolUses[0]!, text: "FAILED", isError: true };
  b.toolUses[0] = { ...b.toolUses[0]!, text: "OK" };
  const sibling = resultMessage("sibling-a", "a", "FAILED", true);
  const joined = resultMessage("joined", "b", "OK");
  const current = [summary, earlier, earlierResult, a, b, sibling, joined, userMessage("last", "next")];
  const text = transcript(promptRow("start", null), callRow("call-earlier", "start", "earlier", "earlier-group"),
    resultRow("result-earlier", "call-earlier", "earlier", "EARLIER"),
    callRow("call-a", "result-earlier", "a"), callRow("call-b", "call-a", "b"),
    resultRow("sibling-a", "call-a", "a", "FAILED", true),
    resultRow("joined", "call-b", "b", "OK"), promptRow("last", "joined"));
  const rebuilt = rebuildTranscript(current, text);
  expect(rebuilt.map((message) => message.handle ?? message.uuid)).toEqual([
    "start", "call-earlier", "result-earlier", "call-a", "call-b", "sibling-a", "joined", "last",
  ]);
  expect(rebuilt.find((message) => message.handle === "sibling-a")).toBe(sibling);
  expect(rebuilt.some((message) => message.handle === "copy-earlier-result")).toBe(false);
  const outcomes = (messages: ClaudeMessage[]) => normalizeMessages(messages).flatMap((event) =>
    event.kind === "toolResult" ? [{ id: event.toolCallId, error: event.isError, text: event.text }] : []);
  const expected = outcomes(current), actual = outcomes(rebuilt);
  expect(actual).toHaveLength(expected.length);
  expect(actual).toEqual(expected);
  expect(outcomeConservationProblem(current, rebuilt)).toBeUndefined();
});

test("an earlier call with excess raw outcomes is left alone when restoring another call", () => {
  const earlier = callMessage("copy-earlier", "earlier");
  earlier.toolUses[0] = { ...earlier.toolUses[0]!, text: "EARLIER" };
  const earlierResult = resultMessage("copy-earlier-result", "earlier", "EARLIER");
  const a = callMessage("copy-a", "a"), b = callMessage("copy-b", "b");
  const sibling = resultMessage("sibling-a", "a", "A");
  const joined = resultMessage("joined", "b", "B");
  const current = [summary, earlier, earlierResult, a, b, sibling, joined, userMessage("last", "next")];
  const text = transcript(promptRow("start", null), callRow("call-earlier", "start", "earlier", "earlier-group"),
    resultRow("result-earlier1", "call-earlier", "earlier", "EARLIER"),
    resultRow("result-earlier2", "result-earlier1", "earlier", "EARLIER"),
    callRow("call-a", "result-earlier2", "a"), callRow("call-b", "call-a", "b"),
    resultRow("sibling-a", "call-a", "a", "A"), resultRow("joined", "call-b", "b", "B"), promptRow("last", "joined"));
  const rebuilt = rebuildTranscript(current, text);
  expect(rebuilt.find((message) => message.handle === "sibling-a")).toBe(sibling);
  expect(rebuilt.some((message) => message.handle === "copy-earlier-result")).toBe(false);
  expect(normalizeMessages(rebuilt).filter((event) => event.kind === "toolResult" && event.toolCallId === "earlier")).toHaveLength(2);
  expect(outcomeConservationProblem(current, rebuilt)).toBeUndefined();
});

test.each([
  { inline: { text: "WRONG", isError: true as const }, rowText: "FAILED", rowError: true },
  { inline: { text: "FAILED", isError: true as const }, rowText: "FAILED", rowError: false },
])("a deficient inline outcome differing from its row is refused: $inline / $rowError", ({ inline, rowText, rowError }) => {
  const a = callMessage("copy-a", "a"), b = callMessage("copy-b", "b");
  a.toolUses[0] = { ...a.toolUses[0]!, ...inline };
  const sibling = resultMessage("sibling-a", "a", rowText, rowError);
  const joined = resultMessage("joined", "b", "OK");
  const current = [summary, a, b, sibling, joined, userMessage("last", "next")];
  const text = transcript(promptRow("start", null), callRow("call-a", "start", "a"),
    callRow("call-b", "call-a", "b"), resultRow("sibling-a", "call-a", "a", rowText, rowError),
    resultRow("joined", "call-b", "b", "OK"), promptRow("last", "joined"));
  const rebuilt = rebuildTranscript(current, text);
  expect(rebuilt.some((message) => message.handle === "sibling-a")).toBe(false);
  expect(outcomeConservationProblem(current, rebuilt)).toBe("missing tool outcome in rebuilt input");
});

test.each([{ inlineExit: 0, rowExit: 1 }, { inlineExit: 1, rowExit: undefined }])(
  "a deficient Bash inline outcome cannot hide a different exit-derived row error: $inlineExit/$rowExit", ({ inlineExit, rowExit }) => {
  const bash = { tool_use_id: "a", tool: "Bash", input: { command: "check" } };
  const a: ClaudeMessage = { role: "assistant", text: "", handle: "copy-a",
    toolUses: [{ ...bash, text: "DONE", result: { exitCode: inlineExit } }] };
  const b = callMessage("copy-b", "b");
  const sibling = resultMessage("sibling-a", "a", "DONE");
  if (rowExit !== undefined) sibling.toolResults![0]!.result = { exitCode: rowExit };
  const joined = resultMessage("joined", "b", "OK");
  const current = [summary, a, b, sibling, joined, userMessage("last", "next")];
  const bashRow = { type: "assistant", uuid: "call-a", parentUuid: "start", message: { id: "parallel", content: [
    { type: "tool_use", id: "a", name: "Bash", input: bash.input },
  ] } };
  const text = transcript(promptRow("start", null), bashRow, callRow("call-b", "call-a", "b"),
    resultRow("sibling-a", "call-a", "a", "DONE"), resultRow("joined", "call-b", "b", "OK"), promptRow("last", "joined"));
  const rebuilt = rebuildTranscript(current, text);
  expect(rebuilt.some((message) => message.handle === "sibling-a")).toBe(false);
  expect(outcomeConservationProblem(current, rebuilt)).toBe("missing tool outcome in rebuilt input");
});

test("an inline-only deficit without a result row is refused", () => {
  const call = callMessage("copy-a", "a");
  call.toolUses[0] = { ...call.toolUses[0]!, text: "INLINE-ONLY", isError: true };
  const joined = userMessage("joined", "next");
  const current = [summary, call, joined];
  const rebuilt = rebuildTranscript(current, transcript(promptRow("start", null), callRow("call-a", "start", "a"),
    promptRow("joined", "call-a")));
  expect(rebuilt.find((message) => message.uuid === "call-a")?.toolUses[0]).toEqual(toolUse("a"));
  expect(outcomeConservationProblem(current, rebuilt)).toBe("missing tool outcome in rebuilt input");
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

test("a nonterminal group with an earlier raw-chain result is refused", () => {
  const a = callMessage("copy-a", "a"), b = callMessage("copy-b", "b");
  const earlier = resultMessage("copy-result-a", "a", "FIRST");
  const sibling = resultMessage("sibling-b", "b", "SECOND", true);
  const joined = userMessage("joined", "next");
  const current = [summary, a, b, earlier, sibling, joined];
  const rebuilt = rebuildTranscript(current, transcript(promptRow("start", null), callRow("call-a", "start", "a"),
    callRow("call-b", "call-a", "b"), resultRow("result-a", "call-b", "a", "FIRST"),
    resultRow("sibling-b", "call-b", "b", "SECOND", true), promptRow("joined", "result-a")));
  expect(rebuilt.map((message) => message.handle ?? message.uuid)).toEqual([
    "start", "call-a", "call-b", "result-a", "joined",
  ]);
  expect(rebuilt.some((message) => message.handle === "sibling-b")).toBe(false);
  expect(outcomeConservationProblem(current, rebuilt)).toBe("missing tool outcome in rebuilt input");
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

const editUse = (id: string) => ({ tool_use_id: id, tool: "Edit", input: { file_path: "same.txt" } });
const editCall = (handle: string, id: string, outcome?: { text: string; isError?: true }): ClaudeMessage =>
  ({ role: "assistant", text: "", toolUses: [{ ...editUse(id), ...outcome }], handle });
const editRow = (uuid: string, parentUuid: string, id: string) =>
  ({ type: "assistant", uuid, parentUuid, message: { id: "parallel", content: [
    { type: "tool_use", id, name: "Edit", input: { file_path: "same.txt" } },
  ] } });

// A refused reconstruction is safe; an accepted one must preserve the effective
// outcome sequence, multiplicity and whether an exact retry resolves a failure.
function expectSameOutcomesOrRefused(current: ClaudeMessage[], rebuilt: ClaudeMessage[]): void {
  const problem = outcomeConservationProblem(current, rebuilt);
  if (problem) {
    expect(problem).toBe("missing tool outcome in rebuilt input");
    return;
  }
  const outcomes = (messages: ClaudeMessage[]) => normalizeMessages(messages).flatMap((event) =>
    event.kind === "toolResult" ? [{ id: event.toolCallId, error: event.isError, text: event.text }] : []);
  const expected = outcomes(current), actual = outcomes(rebuilt);
  expect(actual).toHaveLength(expected.length);
  expect(actual).toEqual(expected);
  const status = (messages: ClaudeMessage[]) => projectOutstanding(normalizeMessages(messages))
    .map((line) => line.replace(/ \[entry [^\]]+\]/g, ""));
  expect(status(rebuilt)).toEqual(status(current));
}

test.each(["before", "after"])("a repeated earlier success %s the joined result cannot resolve a restored failure", (position) => {
  const earlier = editCall("copy-earlier", "earlier", { text: "OK" });
  const earlierResult = resultMessage("copy-earlier-result", "earlier", "OK");
  const a = editCall("copy-a", "a"), c = callMessage("copy-c", "c");
  const sibling = resultMessage("sibling-a", "a", "FAILED", true);
  const joined = resultMessage("joined", "c", "C");
  const repeat = { tool_use_id: "earlier", text: "OK", isError: false };
  if (position === "before") joined.toolResults!.unshift(repeat);
  else joined.toolResults!.push(repeat);
  const current = [summary, earlier, earlierResult, a, c, sibling, joined, userMessage("last", "next")];
  const text = transcript(promptRow("start", null), editRow("call-earlier", "start", "earlier"),
    resultRow("result-earlier", "call-earlier", "earlier", "OK"),
    editRow("call-a", "result-earlier", "a"), callRow("call-c", "call-a", "c"),
    resultRow("sibling-a", "call-a", "a", "FAILED", true),
    { type: "user", uuid: "joined", parentUuid: "call-c", message: { content: joined.toolResults!.map((result) =>
      ({ type: "tool_result", tool_use_id: result.tool_use_id, content: result.text })) } }, promptRow("last", "joined"));

  const currentEvents = normalizeMessages(current);
  expect(currentEvents.flatMap((event) => event.kind === "toolResult" ? [event.toolCallId] : []))
    .toEqual(["earlier", "a", "c"]);
  expect(projectOutstanding(currentEvents).join("\n")).toContain("same.txt: FAILED");
  const rebuilt = rebuildTranscript(current, text);
  expect(outcomeConservationProblem(current, rebuilt)).toBe("missing tool outcome in rebuilt input");
  expect(rebuilt.map((message) => message.handle ?? message.uuid)).toEqual([
    "start", "call-earlier", "result-earlier", "call-a", "call-c", "joined", "last",
  ]);
  expect(rebuilt[5]).toBe(joined);
});

test("inline failure and success cannot be reordered by restoring a sibling row", () => {
  const a = editCall("copy-a", "a", { text: "FAILED", isError: true });
  const b = editCall("copy-b", "b", { text: "OK" });
  const c = callMessage("copy-c", "c");
  const sibling = resultMessage("sibling-a", "a", "FAILED", true);
  const joined = resultMessage("joined", "c", "C");
  const current = [summary, a, b, c, sibling, joined, userMessage("last", "next")];
  const text = transcript(promptRow("start", null), editRow("call-a", "start", "a"),
    editRow("call-b", "call-a", "b"), callRow("call-c", "call-b", "c"),
    resultRow("sibling-a", "call-a", "a", "FAILED", true),
    resultRow("joined", "call-c", "c", "C"), promptRow("last", "joined"));
  expectSameOutcomesOrRefused(current, rebuildTranscript(current, text));
});

test("two result rows cannot duplicate an authoritative inline outcome", () => {
  const a = editCall("copy-a", "a", { text: "FAILED", isError: true });
  const c = callMessage("copy-c", "c");
  const first = resultMessage("sibling-a1", "a", "FAILED", true);
  const second = resultMessage("sibling-a2", "a", "FAILED", true);
  const joined = resultMessage("joined", "c", "C");
  const current = [summary, a, c, first, second, joined, userMessage("last", "next")];
  const text = transcript(promptRow("start", null), editRow("call-a", "start", "a"),
    callRow("call-c", "call-a", "c"), resultRow("sibling-a1", "call-a", "a", "FAILED", true),
    resultRow("sibling-a2", "call-a", "a", "FAILED", true), resultRow("joined", "call-c", "c", "C"),
    promptRow("last", "joined"));
  expectSameOutcomesOrRefused(current, rebuildTranscript(current, text));
});

test("ambiguous repeated raw result anchors cannot move a later failure before successes", () => {
  const a = editCall("copy-a", "a"), b = editCall("copy-b", "b");
  const first = resultMessage("copy-b1", "b", "OK"), second = resultMessage("copy-b2", "b", "OK");
  const missing = resultMessage("sibling-a", "a", "FAILED", true);
  const joined = userMessage("joined", "next");
  const current = [summary, a, b, first, second, missing, joined];
  const text = transcript(promptRow("start", null), editRow("call-a", "start", "a"),
    editRow("call-b", "call-a", "b"), resultRow("result-b1", "call-b", "b", "OK"),
    resultRow("result-b2", "result-b1", "b", "OK"), resultRow("sibling-a", "call-a", "a", "FAILED", true),
    promptRow("joined", "result-b2"));
  expectSameOutcomesOrRefused(current, rebuildTranscript(current, text));
});

test("the converter rejects a row that cannot be addressed", () => {
  expect(() => fromTranscript({ type: "system", uuid: "boundary" })).toThrow("no role or uuid");
  expect(() => fromTranscript({ type: "user", message: { content: "missing id" } })).toThrow("no role or uuid");
});
