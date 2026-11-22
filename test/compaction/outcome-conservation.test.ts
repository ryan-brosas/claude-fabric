import { expect, test } from "bun:test";
import { normalizeMessages, type ClaudeMessage, type ClaudeToolResult, type ClaudeToolUse } from "../../src/compaction/from-claude.ts";
import { outcomeConservationProblem, outcomeResolver, resolveMessageOutcomes } from "../../src/compaction/outcome-conservation.ts";
import { buildKeptReadStub, stubKeptReads } from "../../src/compaction/kept-read.ts";
import type { TranscriptRow } from "../../src/recall/transcript.ts";

const assistant = (...toolUses: ClaudeToolUse[]): ClaudeMessage => ({ role: "assistant", text: "", toolUses });
const user = (...toolResults: ClaudeToolResult[]): ClaudeMessage => ({ role: "user", text: "", toolUses: [], toolResults });
const use = (id: string, text?: string): ClaudeToolUse => ({ tool_use_id: id, tool: "Read", input: {}, ...(text === undefined ? {} : { text }) });
const result = (id: string, text: string, isError = false): ClaudeToolResult => ({ tool_use_id: id, text, isError });

test("only an exact stub with the original non-sidechain result resolves", () => {
  const original = "multi-byte é\n".repeat(2_000), path = "docs/a\"quoted.md", id = "a", entry = "source";
  const stub = buildKeptReadStub(path, entry, original);
  const call = (text: string) => assistant({ tool_use_id: id, tool: "Read", input: { file_path: path }, text });
  const row = (text: string, toolId = id, sidechain = false): TranscriptRow => ({ type: "user", uuid: entry, isSidechain: sidechain,
    toolUseResult: { type: "text", file: { startLine: 1, numLines: 1, totalLines: 1 } },
    message: { content: [{ type: "tool_result", tool_use_id: toolId, content: text }] } });
  const callRow: TranscriptRow = { type: "assistant", uuid: "call", message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: path } }] } };
  const rows = (value?: TranscriptRow) => new Map<string, TranscriptRow>(value ? [[entry, value], ["call", callRow]] : [["call", callRow]]);
  const check = (left: ClaudeMessage[], right: ClaudeMessage[], transcript: Map<string, TranscriptRow>) => {
    const resolve = outcomeResolver(transcript, [...left, ...right]);
    return outcomeConservationProblem(resolveMessageOutcomes(left, resolve), resolveMessageOutcomes(right, resolve));
  };
  const writerCall = { ...assistant({ tool_use_id: id, tool: "Read", input: { file_path: path } }), handle: "call" };
  const writerResult = { ...user(result(id, original)), handle: entry };
  expect(stubKeptReads([user(), writerCall, writerResult], rows(row(original)))[2]!.toolResults![0]!.text).toBe(stub);
  expect(check([call(stub)], [call(original)], rows(row(original)))).toBeUndefined();
  expect(check([call(original)], [call(stub)], rows(row(original)))).toBeUndefined();
  expect(check([], [assistant(...call(original).toolUses, ...call(stub).toolUses)], rows(row(original)))).toBeUndefined();
  const invalid: [string, string, Map<string, TranscriptRow>][] = [
    ["missing entry", stub, rows()],
    ["wrong byte count", stub, rows(row(original + "x"))],
    ["sidechain entry", stub, rows(row(original, id, true))],
    ["wrong tool use id", stub, rows(row(original, "other"))],
    ["altered stub", stub + "!", rows(row(original))],
    ["digest-less legacy stub", stub.replace(/\nSHA-256: [a-f0-9]{64}/, ""), rows(row(original))],
    ["ambiguous call row", stub, new Map([[entry, row(original)], ["call", { ...callRow, message: { content: [
      { type: "tool_use", id, name: "Read", input: { file_path: path } },
      { type: "tool_use", id, name: "Read", input: { file_path: path } },
    ] } }]])],
    ["different result", "a genuinely different result", rows(row(original))],
  ];
  for (const [name, candidate, transcript] of invalid) {
    expect(check([call(candidate)], [call(original)], transcript), name).toBe("conflicting tool outcome id");
  }
  const errorStub = assistant({ tool_use_id: id, tool: "Read", input: { file_path: path }, text: stub, isError: true });
  const errorOriginal = assistant({ tool_use_id: id, tool: "Read", input: { file_path: path }, text: original, isError: true });
  expect(check([errorStub], [errorOriginal], rows(row(original)))).toBe("conflicting tool outcome id");
  expect(check([call(stub)], [call(original + "!")], rows(row(original))))
    .toBe("conflicting tool outcome id");
  const partial = assistant({ tool_use_id: id, tool: "Read", input: { file_path: path, offset: 1 }, text: stub });
  expect(check([partial], [call(original)], rows(row(original)))).toBe("conflicting tool outcome id");
});

test("same-length rewritten transcript content cannot resolve an old stub", () => {
  const original = "a".repeat(32_000), rewritten = "b".repeat(32_000), path = "guide.md", id = "t", entry = "r";
  const stub = buildKeptReadStub(path, entry, original);
  const call = assistant({ tool_use_id: id, tool: "Read", input: { file_path: path } });
  const row: TranscriptRow = { type: "user", uuid: entry, toolUseResult: { type: "text", file: { startLine: 1, numLines: 1, totalLines: 1 } },
    message: { content: [{ type: "tool_result", tool_use_id: id, content: rewritten }] } };
  const current = [call, user(result(id, stub))], rebuilt = [call, user(result(id, rewritten))];
  const rawCall: TranscriptRow = { type: "assistant", uuid: "call", message: { content: [{ type: "tool_use", id, name: "Read", input: call.toolUses[0]!.input }] } };
  const resolve = outcomeResolver(new Map([[entry, row], ["call", rawCall]]), current);
  expect(outcomeConservationProblem(resolveMessageOutcomes(current, resolve), resolveMessageOutcomes(rebuilt, resolve)))
    .toBe("conflicting tool outcome id");
});

test.each(["partial read", "under threshold", "missing metadata", "nested stub"])('a forged %s candidate cannot resolve', (kind) => {
  const id = "t", entry = "r", path = "guide.md";
  const original = kind === "under threshold" ? "a".repeat(100) : kind === "nested stub"
    ? buildKeptReadStub(path, "earlier", "a".repeat(32_000)) : "a".repeat(32_000);
  const input = kind === "partial read" ? { file_path: path, offset: 1 } : { file_path: path };
  const stub = buildKeptReadStub(path, entry, original);
  const call = assistant({ tool_use_id: id, tool: "Read", input });
  const row: TranscriptRow = { type: "user", uuid: entry,
    ...(kind === "missing metadata" ? {} : { toolUseResult: { type: "text", file: { startLine: 1, numLines: 1, totalLines: 1 } } }),
    message: { content: [{ type: "tool_result", tool_use_id: id, content: original }] } };
  const current = [call, user(result(id, stub))], rebuilt = [call, user(result(id, original))];
  const rawCall: TranscriptRow = { type: "assistant", uuid: "call", message: { content: [{ type: "tool_use", id, name: "Read", input: call.toolUses[0]!.input }] } };
  const resolve = outcomeResolver(new Map([[entry, row], ["call", rawCall]]), current);
  expect(outcomeConservationProblem(resolveMessageOutcomes(current, resolve), resolveMessageOutcomes(rebuilt, resolve)))
    .toBe("conflicting tool outcome id");
});

test("inline outcomes suppress result rows in either input", () => {
  const inline = [assistant(use("a", "answer")), user(result("a", "superseded"))];
  const separate = [assistant(use("a")), user(result("a", "answer"))];
  expect(outcomeConservationProblem(inline, separate)).toBeUndefined();
  expect(outcomeConservationProblem(separate, inline)).toBeUndefined();
  expect(outcomeConservationProblem([], [user(result("old", "history"))])).toBeUndefined();
});

test("addressing and whitespace leave the conserved inline outcome unchanged", () => {
  const text = "failure:  a\tb";
  const current = [{ ...assistant(use("a", text)), handle: "call" },
    { ...user(result("a", text, true)), handle: "result" }];
  const equal = [{ ...assistant(use("a")), handle: "other-call" },
    { ...user(result("a", text)), handle: "other-result" }];
  expect(normalizeMessages(current).find((event) => event.kind === "toolResult"))
    .toMatchObject({ entryId: "1", text, isError: false });
  expect(outcomeConservationProblem(current, equal)).toBeUndefined();
  expect(outcomeConservationProblem(current, [assistant(use("a")), user(result("a", "failure: a b"))]))
    .toBe("conflicting tool outcome id");
  expect(outcomeConservationProblem(current, [assistant(use("a")), user(result("a", text, true))]))
    .toBe("conflicting tool outcome id");
  expect(outcomeConservationProblem(current, [assistant(use("different")), user(result("different", text))]))
    .toBe("missing tool outcome in rebuilt input");
});

test("result-only and error-only inline outcomes count even without text", () => {
  const resultOnly = { ...use("a"), result: { ok: true } };
  const errorOnly = { ...use("b"), isError: true as const };
  const inline = [assistant(resultOnly, errorOnly)];
  const separate = [assistant(use("a"), use("b")), user(result("a", ""), result("b", "", true))];
  expect(outcomeConservationProblem(inline, separate)).toBeUndefined();
  expect(outcomeConservationProblem(inline, [assistant(resultOnly)])).toBe("missing tool outcome in rebuilt input");
});

test("every matching outcome occurrence must be available", () => {
  const one = [user(result("a", "same"))];
  const two = [user(result("a", "same"), result("a", "same"))];
  expect(outcomeConservationProblem(two, two)).toBeUndefined();
  expect(outcomeConservationProblem(one, two)).toBeUndefined();
  expect(outcomeConservationProblem(two, one)).toBe("missing tool outcome in rebuilt input");
  expect(outcomeConservationProblem(one, [])).toBe("missing tool outcome in rebuilt input");
  expect(outcomeConservationProblem([assistant(use("a", "same"), use("a", "same"))], one))
    .toBe("missing tool outcome in rebuilt input");
});

test("text, error flag and reused ids cannot conflict", () => {
  const original = [assistant(use("a")), user(result("a", "answer"))];
  expect(outcomeConservationProblem(original, [user(result("a", "different"))])).toBe("conflicting tool outcome id");
  expect(outcomeConservationProblem(original, [user(result("a", "answer", true))])).toBe("conflicting tool outcome id");
  expect(outcomeConservationProblem(original, [user(result("a", "answer"))]))
    .toBe("ambiguous tool outcome: rebuilt input has no tool use");
  expect(() => outcomeConservationProblem([user(result("a", "one"), result("a", "two"))], []))
    .toThrow("conflicting tool outcome id");
  expect(() => outcomeConservationProblem([], [user(result("a", "one"), result("a", "two"))]))
    .toThrow("conflicting tool outcome id");
  expect(() => outcomeConservationProblem([user(result("", "answer"))], []))
    .toThrow("ambiguous tool outcome fields");
  const differentTool = [{ ...use("a"), tool: "Bash" }];
  expect(outcomeConservationProblem(original, [assistant(...differentTool), user(result("a", "answer"))]))
    .toBe("conflicting tool outcome id");
  expect(() => outcomeConservationProblem([assistant(use("a"), ...differentTool)], []))
    .toThrow("conflicting tool use id");
});

test("a Bash exit code that changes the effective error is a conflict", () => {
  const call: ClaudeToolUse = { tool_use_id: "bash", tool: "Bash", input: { command: "check" } };
  const failed = { ...result("bash", "output"), result: { exitCode: 2 } };
  const succeeded = { ...result("bash", "output"), result: { exitCode: 0 } };
  expect(outcomeConservationProblem([assistant(call), user(failed)], [assistant(call), user(succeeded)]))
    .toBe("conflicting tool outcome id");
  expect(outcomeConservationProblem([assistant(call), user(failed)], [assistant(call), user(failed)]))
    .toBeUndefined();
});
