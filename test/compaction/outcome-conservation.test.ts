import { expect, test } from "bun:test";
import type { ClaudeMessage, ClaudeToolResult, ClaudeToolUse } from "../../src/compaction/from-claude.ts";
import { outcomeConservationProblem } from "../../src/compaction/outcome-conservation.ts";

const assistant = (...toolUses: ClaudeToolUse[]): ClaudeMessage => ({ role: "assistant", text: "", toolUses });
const user = (...toolResults: ClaudeToolResult[]): ClaudeMessage => ({ role: "user", text: "", toolUses: [], toolResults });
const use = (id: string, text?: string): ClaudeToolUse => ({ tool_use_id: id, tool: "Read", input: {}, ...(text === undefined ? {} : { text }) });
const result = (id: string, text: string, isError = false): ClaudeToolResult => ({ tool_use_id: id, text, isError });

test("inline outcomes suppress result rows in either input", () => {
  const inline = [assistant(use("a", "answer")), user(result("a", "superseded"))];
  const separate = [assistant(use("a")), user(result("a", "answer"))];
  expect(outcomeConservationProblem(inline, separate)).toBeUndefined();
  expect(outcomeConservationProblem(separate, inline)).toBeUndefined();
  expect(outcomeConservationProblem([], [user(result("old", "history"))])).toBeUndefined();
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
