import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compact } from "../../src/compaction/compact.ts";
import { fromTranscript, rebuildTranscript } from "../../src/compaction/from-transcript.ts";
import { outcomeConservationProblem } from "../../src/compaction/outcome-conservation.ts";
import type { ClaudeMessage } from "../../src/compaction/from-claude.ts";
import { normalizeMessages } from "../../src/compaction/from-claude.ts";
import { valuesIn } from "../../src/compaction/literals.ts";
import { projectOutstanding } from "../../src/compaction/projections.ts";
import { restoreSiblings } from "../../src/compaction/restore-siblings.ts";

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


// Shape from the recorded run: each sibling records the same message/request,
// consecutive block indexes, an ancestry link, and an attributed result.
function siblingFixture(): { rows: Record<string, unknown>[]; current: ClaudeMessage[] } {
  const a = { ...callRow("a", "prompt", "call-a", "pair"), requestRef: "req", apiBlockIndex: 0 };
  const b = { ...callRow("b", "a", "call-b", "pair"), requestRef: "req", apiBlockIndex: 1 };
  return { rows: [promptRow("prompt", null), a, b,
    { ...resultRow("rb", "b", "call-b", "B"), sourceToolAssistantUUID: "b" },
    { ...resultRow("ra", "a", "call-a", "A"), sourceToolAssistantUUID: "a" }, promptRow("joined", "ra")],
    current: [userMessage("summary", "[Fabric summary]\nprior"), userMessage("joined", "after")] };
}
const rowsText = (rows: Record<string, unknown>[]): string => rows.map((row) => JSON.stringify(row)).join("\n");

test("ambiguous same-message calls or outcomes are refused", () => {
  for (const kind of ["duplicate-call", "duplicate-result", "orphan-result"] as const) {
    const { rows, current } = siblingFixture();
    const extra = kind === "duplicate-call"
      ? { ...callRow("dup", "prompt", "call-b", "other"), requestRef: "other", apiBlockIndex: 0 }
      : kind === "duplicate-result"
        ? { ...resultRow("dup", "b", "call-b", "B"), sourceToolAssistantUUID: "b" }
        : { ...resultRow("dup", "b", "no-call", "orphan"), sourceToolAssistantUUID: "b" };
    rows.splice(rows.length - 1, 0, extra);
    expect(() => rebuildTranscript(current, rowsText(rows))).toThrow("ambiguous");
  }
});

test("round3 cross-epoch conflicting owners are refused rather than mispaired", () => {
  const group = (epoch: number, parent: string) => {
    const a = `a${epoch}`, b = `b${epoch}`, ra = `ra${epoch}`, rb = `rb${epoch}`;
    return [
      { ...callRow(a, parent, `anchor${epoch}`, `message${epoch}`), requestRef: `req${epoch}`, apiBlockIndex: 0 },
      { ...callRow(b, a, "shared", `message${epoch}`), requestRef: `req${epoch}`, apiBlockIndex: 1 },
      { ...resultRow(rb, b, "shared", epoch ? "NEW" : "OLD"), sourceToolAssistantUUID: b },
      { ...resultRow(ra, a, `anchor${epoch}`, `A${epoch}`), sourceToolAssistantUUID: a },
    ];
  };
  const rows = [promptRow("start", null), ...group(0, "start"),
    { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: "ra0" },
    ...group(1, "boundary"), promptRow("joined", "ra1")];
  expect(() => rebuildTranscript([summary, userMessage("joined", "next")], rowsText(rows))).toThrow("ambiguous");
});

for (const placement of ["joined-tail", "prefix-only"] as const) {
  test(`round4 conflicting existing owner in ${placement} cannot suppress an off-chain call`, () => {
    const a0 = { ...callRow("a0", "start", "anchor", "message0"), requestRef: "request0", apiBlockIndex: 0 };
    const b0 = { ...callRow("b0", "a0", "shared", "message0"), requestRef: "request0", apiBlockIndex: 1 };
    const rb0 = { ...resultRow("rb0", "b0", "shared", "OLD"), sourceToolAssistantUUID: "b0" };
    const ra0 = { ...resultRow("ra0", "a0", "anchor", "A"), sourceToolAssistantUUID: "a0" };
    const c1 = { ...callRow("c1", "boundary", "shared", "message1"), requestRef: "request1", apiBlockIndex: 0,
      message: { id: "message1", content: [{ type: "tool_use", id: "shared", name: "Read", input: { file_path: "new.txt" } }] } };
    const d1 = { ...callRow("d1", "c1", "other", "message1"), requestRef: "request1", apiBlockIndex: 1 };
    const rd1 = { ...resultRow("rd1", "d1", "other", "D"), sourceToolAssistantUUID: "d1" };
    const boundary = { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: "ra0" };
    const rc1 = { ...resultRow("rc1", "c1", "shared", "NEW"), sourceToolAssistantUUID: "c1" };
    const rows = placement === "joined-tail"
      ? [promptRow("start", null), a0, b0, rb0, ra0, boundary, c1, d1, rd1, { ...rc1, uuid: "joined" }]
      : [promptRow("start", null), a0, b0, rb0, ra0, boundary, c1, rc1, promptRow("joined", "rc1")];
    const current = placement === "joined-tail" ? [summary, resultMessage("joined", "shared", "NEW")]
      : [summary, userMessage("joined", "after")];
    expect(() => rebuildTranscript(current, rowsText(rows))).toThrow("ambiguous");
  });
}
test("round4 conflicting result source cannot suppress a historical outcome", () => {
  const a = { ...callRow("a", "start", "anchor", "pair"), requestRef: "req", apiBlockIndex: 0 };
  const b = { ...callRow("b", "a", "shared", "pair"), requestRef: "req", apiBlockIndex: 1 };
  const rb = { ...resultRow("rb", "b", "shared", "OLD"), sourceToolAssistantUUID: "b" };
  const rogue = { ...callRow("rogue", "start", "shared", "other"), requestRef: "other", apiBlockIndex: 0,
    message: { id: "other", content: [{ type: "tool_use", id: "shared", name: "Read", input: { file_path: "other.txt" } }] } };
  const rr = { ...resultRow("rr", "a", "shared", "NEW"), sourceToolAssistantUUID: "rogue" };
  const rows = [promptRow("start", null), a, b, rb, rogue, rr, promptRow("joined", "rr")];
  expect(() => rebuildTranscript([summary, userMessage("joined", "after")], rowsText(rows))).toThrow("ambiguous");
});
test("round8 even a uniquely matched opaque tail call is refused", () => {
  const { rows, current } = siblingFixture();
  const opaque: ClaudeMessage = { ...callMessage("opaque", "call-b"), toolUses: [{ ...toolUse("call-b"), text: "B" }] };
  expect(() => rebuildTranscript([...current, opaque], rowsText(rows))).toThrow("ambiguous");
});
test("round5 opaque tail call with no matching identity is refused", () => {
  const { rows, current } = siblingFixture();
  const opaque: ClaudeMessage = { ...callMessage("opaque", "call-b"),
    toolUses: [{ tool_use_id: "call-b", tool: "Read", input: { file_path: "different.txt" }, text: "B" }] };
  expect(() => rebuildTranscript([...current, opaque], rowsText(rows))).toThrow("ambiguous");
});

test("round8 opaque tail call and matching physical copies are refused", () => {
  const { rows, current } = siblingFixture();
  rows.splice(rows.length - 1, 0, { type: "system", subtype: "compact_boundary", uuid: "retry-boundary", parentUuid: "prompt" },
    { ...callRow("retry", "retry-boundary", "call-b", "pair"), requestRef: "req", apiBlockIndex: 1 });
  const opaque: ClaudeMessage = { ...callMessage("opaque", "call-b"), toolUses: [{ ...toolUse("call-b"), text: "B" }] };
  expect(() => rebuildTranscript([...current, opaque], rowsText(rows))).toThrow("ambiguous");
});
test("round4 opaque tail call with multiple possible recorded owners is refused", () => {
  const { rows, current } = siblingFixture();
  rows.splice(rows.length - 1, 0,
    { ...callRow("retry", "prompt", "call-b", "other-message"), requestRef: "other-request", apiBlockIndex: 0 });
  const opaque: ClaudeMessage = { ...callMessage("opaque", "call-b"), toolUses: [{ ...toolUse("call-b"), text: "B" }] };
  expect(() => rebuildTranscript([...current, opaque], rowsText(rows))).toThrow("ambiguous");
});
test("round8 a physical copy with omitted structured result is refused", () => {
  const a0 = { ...callRow("a0", "start", "anchor", "same"), requestRef: "req", apiBlockIndex: 0 };
  const b0 = { ...callRow("b0", "a0", "shared", "same"), requestRef: "req", apiBlockIndex: 1 };
  const rb0 = { ...resultRow("rb0", "b0", "shared", "SAME"), sourceToolAssistantUUID: "b0", toolUseResult: { bytes: 4 } };
  const ra0 = { ...resultRow("ra0", "a0", "anchor", "A"), sourceToolAssistantUUID: "a0" };
  const boundary = { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: "ra0" };
  const c1 = { ...callRow("c1", "boundary", "shared", "same"), requestRef: "req", apiBlockIndex: 1 };
  const joined = { ...resultRow("joined", "c1", "shared", "SAME"), sourceToolAssistantUUID: "c1" };
  const rows = [promptRow("start", null), a0, b0, rb0, ra0, boundary, c1, joined];
  const current = [summary, resultMessage("joined", "shared", "SAME")];
  expect(() => rebuildTranscript(current, rowsText(rows))).toThrow("ambiguous");
});
test("round8 claims outside the active row map also refuse restoration", () => {
  for (const kind of ["sidechain call", "unaddressed call", "sidechain result"]) {
    const { rows, current } = siblingFixture();
    const rogue = kind === "sidechain result"
      ? { ...resultRow("rogue-result", "prompt", "call-b", "B"), isSidechain: true, sourceToolAssistantUUID: "other" }
      : { ...callRow("rogue-call", "prompt", "call-b", "other"), isSidechain: kind === "sidechain call",
        uuid: kind === "unaddressed call" ? undefined : "rogue-call" };
    rows.splice(rows.length - 1, 0, rogue);
    expect(() => rebuildTranscript(current, rowsText(rows))).toThrow("ambiguous");
  }
});
test("round8 repeated physical claim with the same row uuid is one owner", () => {
  const { rows, current } = siblingFixture();
  const duplicate = { ...rows[2]!, isSidechain: true,
    message: { id: "unrelated-wrapper", content: [
      { type: "tool_use", id: "call-b", name: "Read", input: { file_path: "different.txt" } },
    ] } };
  rows.splice(rows.length - 1, 0, duplicate);
  const rebuilt = rebuildTranscript(current, rowsText(rows));
  expect(rebuilt.find((message) => message.uuid === "b")?.toolUses[0]?.text).toBe("B");
});
test("round8 source-bound current result permits unrendered Read metadata differences", () => {
  const { rows, current } = siblingFixture();
  rows[3] = { ...rows[3], toolUseResult: { data: 0 } };
  const bound = resultMessage("rb", "call-b", "B");
  bound.toolResults![0]!.result = { data: 1 };
  current.splice(1, 0, bound);
  const rebuilt = rebuildTranscript(current, rowsText(rows));
  expect(outcomeConservationProblem(current, rebuilt)).toBeUndefined();
  expect(normalizeMessages(rebuilt).filter((event) => event.kind === "toolResult" && event.toolCallId === "call-b"))
    .toMatchObject([{ text: "B" }]);
});
test("round8 opaque result cannot borrow a historical caller across epochs", () => {
  const a = { ...callRow("a", "p", "anchor", "pair"), requestRef: "pair", apiBlockIndex: 0 };
  const b = { ...callRow("b", "a", "shared", "pair"), requestRef: "pair", apiBlockIndex: 1,
    message: { id: "pair", content: [
      { type: "tool_use", id: "shared", name: "Read", input: { file_path: "old.txt" } },
    ] } };
  const rb = { ...resultRow("rb", "b", "shared", "SAME"), sourceToolAssistantUUID: "b" };
  const ra = { ...resultRow("ra", "a", "anchor", "A"), sourceToolAssistantUUID: "a" };
  const boundary = { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: "joined" };
  const other = { ...callRow("other", "boundary", "shared", "other-message"), requestRef: "other-request", apiBlockIndex: 0,
    message: { id: "other-message", content: [
      { type: "tool_use", id: "shared", name: "Read", input: { file_path: "new.txt" } },
    ] } };
  const rother = { ...resultRow("rother", "other", "shared", "SAME"), sourceToolAssistantUUID: "other" };
  const current = [summary, userMessage("joined", "after"), resultMessage("opaque-result", "shared", "SAME")];
  const rows = [promptRow("p", null), a, b, rb, ra, promptRow("joined", "ra"), boundary, other, rother];
  expect(() => rebuildTranscript(current, rowsText(rows))).toThrow("ambiguous");
});
test("round8 opaque result refuses even when only one recorded call exists", () => {
  const a = { ...callRow("a", "p", "anchor", "pair"), requestRef: "pair", apiBlockIndex: 0 };
  const b = { ...callRow("b", "a", "shared", "pair"), requestRef: "pair", apiBlockIndex: 1 };
  const rb = { ...resultRow("rb", "b", "shared", "SAME"), sourceToolAssistantUUID: "b" };
  const ra = { ...resultRow("ra", "a", "anchor", "A"), sourceToolAssistantUUID: "a" };
  const rows = [promptRow("p", null), a, b, rb, ra, promptRow("joined", "ra")];
  const opaque = resultMessage("opaque-result", "shared", "SAME");
  for (const current of [[summary, userMessage("joined", "after"), opaque],
    [summary, opaque, userMessage("joined", "after")]]) {
    expect(() => rebuildTranscript(current, rowsText(rows))).toThrow("ambiguous");
  }
});
test("round6 successful Bash bodies with different protected paths cannot be suppressed", () => {
  const a0 = { ...callRow("a0", "start", "anchor", "same"), requestRef: "req", apiBlockIndex: 0 };
  const bash = (uuid: string, parentUuid: string) => ({ ...callRow(uuid, parentUuid, "shared", "same"),
    requestRef: "req", apiBlockIndex: 1, message: { id: "same", content: [
      { type: "tool_use", id: "shared", name: "Bash", input: { command: "cat receipt.txt" } },
    ] } });
  const b0 = bash("b0", "a0"), c1 = bash("c1", "boundary");
  const old = "/tmp/old-receipt.json", next = "/tmp/new-receipt.json";
  const rb0 = { ...resultRow("rb0", "b0", "shared", old), sourceToolAssistantUUID: "b0", toolUseResult: { exitCode: 0 } };
  const ra0 = { ...resultRow("ra0", "a0", "anchor", "A"), sourceToolAssistantUUID: "a0" };
  const boundary = { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: "ra0" };
  const joined = { ...resultRow("joined", "c1", "shared", next), sourceToolAssistantUUID: "c1", toolUseResult: { exitCode: 0 } };
  const historical = [fromTranscript(b0), fromTranscript(rb0)], retained = [fromTranscript(c1), fromTranscript(joined)];
  expect(normalizeMessages(historical)).toEqual(normalizeMessages(retained));
  expect(valuesIn(old)).toContain(old);
  expect(valuesIn(next)).toContain(next);
  const current = [summary, { ...resultMessage("joined", "shared", next), toolResults: [
    { tool_use_id: "shared", text: next, isError: false, result: { exitCode: 0 } },
  ] }];
  expect(() => rebuildTranscript(current, rowsText([promptRow("start", null), a0, b0, rb0, ra0, boundary, c1, joined])))
    .toThrow("ambiguous");
});

test("round6 explicit Bash flag conflict refuses copied callers", () => {
  const a0 = { ...callRow("a0", "start", "anchor", "same"), requestRef: "req", apiBlockIndex: 0 };
  const bash = (uuid: string, parentUuid: string) => ({ ...callRow(uuid, parentUuid, "shared", "same"),
    requestRef: "req", apiBlockIndex: 1, message: { id: "same", content: [
      { type: "tool_use", id: "shared", name: "Bash", input: { command: "false" } },
    ] } });
  const b0 = bash("b0", "a0"), c1 = bash("c1", "boundary");
  const rb0 = { ...resultRow("rb0", "b0", "shared", "", false), sourceToolAssistantUUID: "b0", toolUseResult: { exitCode: 1 } };
  const ra0 = { ...resultRow("ra0", "a0", "anchor", "A"), sourceToolAssistantUUID: "a0" };
  const boundary = { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: "ra0" };
  const joined = { ...resultRow("joined", "c1", "shared", "", true), sourceToolAssistantUUID: "c1", toolUseResult: { exitCode: 1 } };
  expect(normalizeMessages([fromTranscript(b0), fromTranscript(rb0)]))
    .toEqual(normalizeMessages([fromTranscript(c1), fromTranscript(joined)]));
  const current = [summary, { ...resultMessage("joined", "shared", "", true), toolResults: [
    { tool_use_id: "shared", text: "", isError: true, result: { exitCode: 1 } },
  ] }];
  expect(() => rebuildTranscript(current, rowsText([promptRow("start", null), a0, b0, rb0, ra0, boundary, c1, joined])))
    .toThrow("ambiguous");
});
test("round6 opaque attribution counts every duplicate-id occurrence in another epoch", () => {
  const a0 = { ...callRow("a0", "start", "anchor", "pair"), requestRef: "req", apiBlockIndex: 0 };
  const b0 = { ...callRow("b0", "a0", "shared", "pair"), requestRef: "req", apiBlockIndex: 1 };
  const rb0 = { ...resultRow("rb0", "b0", "shared", "B"), sourceToolAssistantUUID: "b0" };
  const ra0 = { ...resultRow("ra0", "a0", "anchor", "A"), sourceToolAssistantUUID: "a0" };
  const boundary = { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: "start" };
  const rogue = { ...callRow("rogue", "boundary", "shared", "other"), requestRef: "other-req", apiBlockIndex: 0,
    message: { id: "other", content: [
      { type: "tool_use", id: "shared", name: "Read", input: { file_path: "different.txt" } },
      { type: "tool_use", id: "shared", name: "Read", input: { file_path: "shared.txt" } },
    ] } };
  const opaque: ClaudeMessage = { ...callMessage("opaque", "shared"), toolUses: [{ ...toolUse("shared"), text: "B" }] };
  const rows = [promptRow("start", null), a0, b0, rb0, ra0, boundary, rogue, promptRow("joined", "ra0")];
  expect(() => rebuildTranscript([summary, userMessage("joined", "after"), opaque], rowsText(rows))).toThrow("ambiguous");
});
test("round5 omitted Bash exit cannot suppress a historical failure", () => {
  const a0 = { ...callRow("a0", "start", "anchor", "same"), requestRef: "req", apiBlockIndex: 0 };
  const bash = (uuid: string, parentUuid: string) => ({ ...callRow(uuid, parentUuid, "shared", "same"),
    requestRef: "req", apiBlockIndex: 1, message: { id: "same", content: [
      { type: "tool_use", id: "shared", name: "Bash", input: { command: "false" } },
    ] } });
  const b0 = bash("b0", "a0"), c1 = bash("c1", "boundary");
  const rb0 = { ...resultRow("rb0", "b0", "shared", "SAME"), sourceToolAssistantUUID: "b0", toolUseResult: { exitCode: 1 } };
  const ra0 = { ...resultRow("ra0", "a0", "anchor", "A"), sourceToolAssistantUUID: "a0" };
  const boundary = { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: "ra0" };
  const joined = { ...resultRow("joined", "c1", "shared", "SAME"), sourceToolAssistantUUID: "c1" };
  const historical = normalizeMessages([fromTranscript(b0), fromTranscript(rb0)]).find((event) => event.kind === "bash");
  const retained = normalizeMessages([fromTranscript(c1), resultMessage("joined", "shared", "SAME")]).find((event) => event.kind === "bash");
  expect(historical).toMatchObject({ isError: true, exitCode: 1 });
  expect(retained).toMatchObject({ isError: false, exitCode: null });
  expect(() => rebuildTranscript([summary, resultMessage("joined", "shared", "SAME")],
    rowsText([promptRow("start", null), a0, b0, rb0, ra0, boundary, c1, joined]))).toThrow("ambiguous");
});

test("round8 physical copies refuse irrespective of wrapper, metadata or input key order", () => {
  const group = (epoch: number, parent: string, tool: string, reorderInput: boolean) => {
    const a = `ka${epoch}`, b = `kb${epoch}`;
    const input = epoch && reorderInput ? { options: { second: 2, first: 1 }, file_path: "same.txt" }
      : { file_path: "same.txt", options: { first: 1, second: 2 } };
    const block = epoch ? { id: "shared", type: "tool_use", name: tool, input }
      : { type: "tool_use", id: "shared", name: tool, input };
    const result = epoch ? { beta: 2, alpha: 1 } : { alpha: 1, beta: 2 };
    return [
      { ...callRow(a, parent, `anchor${epoch}`, "same-message"), requestRef: "same-request", apiBlockIndex: 0 },
      { ...callRow(b, a, "shared", "same-message"), requestRef: "same-request", apiBlockIndex: 1,
        message: { id: "same-message", content: [block] } },
      { ...resultRow(`krb${epoch}`, b, "shared", "SAME"), sourceToolAssistantUUID: b, toolUseResult: result },
      { ...resultRow(`kra${epoch}`, a, `anchor${epoch}`, "anchor"), sourceToolAssistantUUID: a },
    ];
  };
  const rows = (tool: string, reorderInput: boolean) => [promptRow("start", null), ...group(0, "start", tool, reorderInput),
    { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: "kra0" },
    ...group(1, "boundary", tool, reorderInput), promptRow("joined", "kra1")];
  for (const tool of ["Read", "MCP"]) {
    expect(() => rebuildTranscript([summary, userMessage("joined", "next")], rowsText(rows(tool, false))))
      .toThrow("ambiguous");
    expect(() => rebuildTranscript([summary, userMessage("joined", "next")], rowsText(rows(tool, true))))
      .toThrow("ambiguous");
  }
});

test("round4 covered copy with conflicting outcome cannot suppress historical outcome", () => {
  const a0 = { ...callRow("a0", "start", "anchor", "same"), requestRef: "req", apiBlockIndex: 0 };
  const b0 = { ...callRow("b0", "a0", "shared", "same"), requestRef: "req", apiBlockIndex: 1 };
  const rb0 = { ...resultRow("rb0", "b0", "shared", "OLD"), sourceToolAssistantUUID: "b0" };
  const ra0 = { ...resultRow("ra0", "a0", "anchor", "A"), sourceToolAssistantUUID: "a0" };
  const boundary = { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: "ra0" };
  const c1 = { ...callRow("c1", "boundary", "shared", "same"), requestRef: "req", apiBlockIndex: 1 };
  const joined = { ...resultRow("joined", "c1", "shared", "NEW"), sourceToolAssistantUUID: "c1" };
  const rows = [promptRow("start", null), a0, b0, rb0, ra0, boundary, c1, joined];
  expect(() => rebuildTranscript([summary, resultMessage("joined", "shared", "NEW")], rowsText(rows))).toThrow("ambiguous");
});
test("round8 identical cross-epoch physical copies are refused", () => {
  const group = (epoch: number, parent: string) => {
    const a = `ca${epoch}`, b = `cb${epoch}`;
    return [
      { ...callRow(a, parent, `anchor${epoch}`, "same-message"), requestRef: "same-request", apiBlockIndex: 0 },
      { ...callRow(b, a, "shared", "same-message"), requestRef: "same-request", apiBlockIndex: 1 },
      { ...resultRow(`crb${epoch}`, b, "shared", "SAME"), sourceToolAssistantUUID: b },
      { ...resultRow(`cra${epoch}`, a, `anchor${epoch}`, "anchor"), sourceToolAssistantUUID: a },
    ];
  };
  const rows = [promptRow("start", null), ...group(0, "start"),
    { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: "cra0" },
    ...group(1, "boundary"), promptRow("joined", "cra1")];
  expect(() => rebuildTranscript([summary, userMessage("joined", "next")], rowsText(rows))).toThrow("ambiguous");
});
test("round8 cross-epoch Read copies refuse despite equal normalized events", () => {
  const group = (epoch: number, parent: string) => {
    const a = `sa${epoch}`, b = `sb${epoch}`;
    return [
      { ...callRow(a, parent, `anchor${epoch}`, "same-message"), requestRef: "same-request", apiBlockIndex: 0 },
      { ...callRow(b, a, "shared", "same-message"), requestRef: "same-request", apiBlockIndex: 1 },
      { ...resultRow(`srb${epoch}`, b, "shared", "SAME"), sourceToolAssistantUUID: b, toolUseResult: { data: epoch } },
      { ...resultRow(`sra${epoch}`, a, `anchor${epoch}`, "anchor"), sourceToolAssistantUUID: a },
    ];
  };
  const rows = [promptRow("start", null), ...group(0, "start"),
    { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: "sra0" },
    ...group(1, "boundary"), promptRow("joined", "sra1")];
  expect(normalizeMessages([fromTranscript(rows[2]!), fromTranscript(rows[3]!)]))
    .toEqual(normalizeMessages([fromTranscript(rows[7]!), fromTranscript(rows[8]!)]));
  expect(() => rebuildTranscript([summary, userMessage("joined", "next")], rowsText(rows))).toThrow("ambiguous");
});

test("round5 Read copies with different effective text are refused", () => {
  const { rows, current } = siblingFixture();
  const opaque: ClaudeMessage = { ...callMessage("opaque", "call-b"),
    toolUses: [{ ...toolUse("call-b"), text: "different" }] };
  expect(() => rebuildTranscript([...current, opaque], rowsText(rows))).toThrow("ambiguous");
});
test("round3 duplicate tool id twice in one off-chain row is refused", () => {
  const { rows, current } = siblingFixture();
  const message = rows[2]!.message as { content: object[] };
  message.content.push({ ...message.content[0] });
  expect(() => rebuildTranscript(current, rowsText(rows))).toThrow("ambiguous");
});

test("round3 late historical result does not disable terminal restoration", () => {
  const { rows } = siblingFixture();
  rows.pop();
  rows.push(callRow("c", "ra", "call-c", "terminal"), callRow("d", "c", "call-d", "terminal"),
    resultRow("result-c", "c", "call-c", "C"), resultRow("result-d", "d", "call-d", "D"));
  rows.splice(rows.findIndex((r) => r.uuid === "result-c"), 0, rows.splice(rows.findIndex((r) => r.uuid === "rb"), 1)[0]!);
  const current = [summary, resultMessage("result-c", "call-c", "C"), resultMessage("result-d", "call-d", "D")];
  const rebuilt = rebuildTranscript(current, rowsText(rows));
  expect(rebuilt.some((message) => message.uuid === "rb")).toBe(true);
  expect(rebuilt.some((message) => message.handle === "result-c")).toBe(true);
  expect(outcomeConservationProblem(current, rebuilt)).toBeUndefined();
});

test("round3 outcomes straddling join still rebuild", () => {
  const a = { ...callRow("a", "start", "a", "pair"), requestRef: "req", apiBlockIndex: 0 };
  const b = { ...callRow("b", "a", "b", "pair"), requestRef: "req", apiBlockIndex: 1 };
  const off = { ...resultRow("off", "a", "a", "A"), sourceToolAssistantUUID: "a" };
  const joined = { ...resultRow("joined", "b", "b", "B"), sourceToolAssistantUUID: "b" };
  const current = [summary, resultMessage("off", "a", "A"), resultMessage("joined", "b", "B")];
  const rebuilt = rebuildTranscript(current, transcript(promptRow("start", null), a, b, off, joined));
  expect(outcomeConservationProblem(current, rebuilt)).toBeUndefined();
  expect(normalizeMessages(rebuilt).filter((x) => x.kind === "toolResult").map((x) => x.toolCallId)).toEqual(["a", "b"]);
});

test("round3 ten thousand ordinary calls avoid quadratic scanning", () => {
  const count = 10_000;
  const rows = Array.from({ length: count }, (_, i) =>
    ({ ...callRow(`call${i}`, i ? `call${i - 1}` : "start", `id${i}`, `msg${i}`), requestRef: `req${i}`, apiBlockIndex: 0 }));
  const chain = [promptRow("start", null), ...rows, promptRow("joined", `call${count - 1}`)];
  const map = new Map(chain.map((row) => [row.uuid, row]));
  const start = performance.now();
  const restored = restoreSiblings(chain, map, chain.length - 1, [userMessage("joined", "next")], [userMessage("joined", "next")], chain);
  const elapsed = performance.now() - start;
  expect(restored.rows).toEqual(chain.slice(0, -1));
  expect(restored.pairs.size).toBe(0);
  expect(elapsed).toBeLessThan(1000);
}, 30000);

test("sidechain and different-message abandoned branches are not imported", () => {
  for (const kind of ["sidechain", "abandoned"] as const) {
    const { rows, current } = siblingFixture();
    const candidate = rows[2]!;
    if (kind === "sidechain") { candidate.isSidechain = true; rows[3]!.isSidechain = true; }
    else candidate.message = { ...candidate.message as object, id: "different" };
    const rebuilt = rebuildTranscript(current, rowsText(rows));
    expect(rebuilt.flatMap((message) => message.toolUses).some((use) => use.tool_use_id === "call-b")).toBe(false);
  }
});

test("a uniquely sourced result for a single historical call is not silently dropped", () => {
  const { rows, current } = siblingFixture();
  rows.splice(2, rows.length - 2, rows[4]!, promptRow("joined", "a"));
  const rebuilt = rebuildTranscript(current, rowsText(rows));
  expect(rebuilt.flatMap((message) => message.toolResults ?? []).filter((entry) => entry.tool_use_id === "call-a")).toHaveLength(1);
});

test("two candidate rows claiming one response block are refused even if message and request ids match", () => {
  const { rows, current } = siblingFixture();
  rows.splice(rows.length - 1, 0,
    { ...callRow("retry", "a", "call-retry", "pair"), requestRef: "req", apiBlockIndex: 1 },
    { ...resultRow("retry-result", "retry", "call-retry", "other"), sourceToolAssistantUUID: "retry" });
  expect(() => rebuildTranscript(current, rowsText(rows))).toThrow("ambiguous");
});

test("a historical restore refuses when the final current-outcome conservation gate fails", () => {
  const { rows } = siblingFixture();
  const current = [summary, resultMessage("phantom", "missing", "MISSING"), userMessage("joined", "after")];
  expect(() => rebuildTranscript(current, rowsText(rows))).toThrow("missing tool outcome in rebuilt input");
});

test("historical and terminal restoration cannot restore the same result twice", () => {
  const { rows } = siblingFixture();
  rows.pop();
  rows.push(callRow("c", "ra", "call-c", "terminal"), callRow("d", "c", "call-d", "terminal"),
    resultRow("result-c", "c", "call-c", "C"), resultRow("result-d", "d", "call-d", "D"));
  const current = [summary, resultMessage("result-c", "call-c", "C"), resultMessage("result-d", "call-d", "D")];
  const rebuilt = rebuildTranscript(current, rowsText(rows));
  for (const id of ["call-b", "call-c", "call-d"]) {
    expect(rebuilt.flatMap((message) => message.toolResults ?? []).filter((result) => result.tool_use_id === id)).toHaveLength(1);
  }
  expect(rebuilt.some((message) => message.uuid === "rb")).toBe(true);
  expect(rebuilt.some((message) => message.handle === "result-c")).toBe(true);
  expect(outcomeConservationProblem(current, rebuilt)).toBeUndefined();
});

test("round8 six recorded groups refuse their unbound current outcomes", () => {
  const fixtures: { n: number; id: string; rows: Record<string, unknown>[]; current: ClaudeMessage[] }[] =
    JSON.parse(readFileSync(new URL("./fixtures/parallel-six-fallbacks.json", import.meta.url), "utf8"));
  expect(fixtures).toHaveLength(6);
  for (const fixture of fixtures) {
    expect(() => rebuildTranscript(fixture.current, rowsText(fixture.rows)))
      .toThrow(`tool-use id ${fixture.id}: unbound current result`);
  }
});
test("round8 recorded off-chain parallel copies refuse the rebuild", () => {
  // Run n=3, prefix before its third compaction; paths and long bodies were shortened.
  const prefix = readFileSync(new URL("./fixtures/parallel-n3-prefix.jsonl", import.meta.url), "utf8");
  const current: ClaudeMessage[] = JSON.parse(readFileSync(new URL("./fixtures/parallel-n3-event.json", import.meta.url), "utf8"));
  expect(() => rebuildTranscript(current, prefix))
    .toThrow("tool-use id chatcmpl-tool-80de3626d1e386af: 2 assistant rows");
});
test("the converter rejects a row that cannot be addressed", () => {
  expect(() => fromTranscript({ type: "system", uuid: "boundary" })).toThrow("no role or uuid");
  expect(() => fromTranscript({ type: "user", message: { content: "missing id" } })).toThrow("no role or uuid");
});
