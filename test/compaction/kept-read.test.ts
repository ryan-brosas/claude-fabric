import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ClaudeMessage } from "../../src/compaction/from-claude.ts";
import { READ_STUB_MAX_BYTES, READ_STUB_THRESHOLD, readDigest, stubKeptReads } from "../../src/compaction/kept-read.ts";
import { utf8Bytes } from "../../src/compaction/bounds.ts";

type Options = { text?: string; tool?: string; input?: Record<string, unknown>; error?: boolean; resultContent?: unknown; resultMeta?: unknown; extraBlock?: unknown; resultId?: string; callInTail?: boolean };
const fixture = (options: Options = {}) => {
  const text = options.text ?? "x".repeat(32_000);
  const tool = options.tool ?? "Read", input = options.input ?? { file_path: "docs/guide.md" };
  const id = options.resultId ?? "result-uuid";
  const summary: ClaudeMessage = { role: "user", text: "[Fabric summary]", toolUses: [] };
  const call: ClaudeMessage = { role: "assistant", text: "", handle: "call-uuid", toolUses: [{ tool_use_id: "t1", tool, input, text }] };
  const result: ClaudeMessage = { role: "user", text: "", handle: id, toolUses: [], toolResults: [{ tool_use_id: "t1", text, isError: options.error ?? false }] };
  const messages = options.callInTail === false ? [summary, result] : [summary, call, result];
  const resultBlock = { type: "tool_result", tool_use_id: "t1", content: options.resultContent ?? text, is_error: options.error ?? false };
  const rows = [
    { type: "assistant", uuid: "call-uuid", message: { content: [{ type: "tool_use", id: "t1", name: tool, input }] } },
    { type: "user", uuid: id, toolUseResult: options.resultMeta ?? { type: "text", file: { startLine: 1, numLines: 10, totalLines: 10 } },
      message: { content: options.extraBlock ? [resultBlock, options.extraBlock] : [resultBlock] } },
  ];
  return { text, messages, rows, transcript: rows.map((r) => JSON.stringify(r)).join("\n") };
};

test("portable SHA-256 matches known vectors and block boundaries", () => {
  expect(readDigest("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(readDigest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for (const length of [1, 55, 56, 63, 64, 65, 127, 128, 129, 16_384, 1_000_000]) {
    const text = "x".repeat(length);
    expect(readDigest(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  }
  const unicode = "é🧪\ud800".repeat(83);
  expect(readDigest(unicode)).toBe(createHash("sha256").update(unicode, "utf8").digest("hex"));
});

describe("stubbing a kept whole-file Read", () => {
  test("explains compaction, not Read truncation, and asks for a plain Read", () => {
    const f = fixture();
    const stub = stubKeptReads(f.messages, f.transcript)[2]!.toolResults![0]!.text;
    expect(stub).toContain("Compaction removed this earlier Read result to save context.");
    expect(stub).toContain("The Read had returned the whole file: 32000 UTF-8 bytes.");
    expect(stub).toContain("Nothing was cut by the Read tool.");
    expect(stub).toContain("call Read on the file with no offset or limit; it returns the whole file.");
    expect(stub).not.toContain("history.expand");
  });
  test("keeps the threshold boundary and replaces one byte above it", () => {
    for (const size of [READ_STUB_THRESHOLD - 1, READ_STUB_THRESHOLD]) {
      const f = fixture({ text: "x".repeat(size) });
      expect(stubKeptReads(f.messages, f.transcript)).toEqual(f.messages);
    }
    const f = fixture({ text: "x".repeat(READ_STUB_THRESHOLD + 1) });
    const out = stubKeptReads(f.messages, f.transcript);
    expect(out[0]).toBe(f.messages[0]);
    expect(out[1]).toBe(f.messages[1]);
    expect(out[2]!.handle).toBeUndefined();
    const stub = out[2]!.toolResults![0]!;
    expect(stub.tool_use_id).toBe("t1");
    expect(stub.text).toContain("docs/guide.md");
    expect(stub.text).toContain(String(READ_STUB_THRESHOLD + 1));
    expect(stub.text).toContain("result-uuid");
    expect(stub.text).toContain(`SHA-256: ${createHash("sha256").update(f.text, "utf8").digest("hex")}`);
    expect(utf8Bytes(stub.text)).toBeLessThanOrEqual(READ_STUB_MAX_BYTES);
    expect(utf8Bytes(stub.text)).toBeLessThanOrEqual(utf8Bytes(f.text));
  });

  test("accepts a whole-file Read with allow_large", () => {
    const f = fixture({ input: { file_path: "docs/guide.md", allow_large: true } });
    expect(stubKeptReads(f.messages, f.transcript)[2]!.toolResults![0]!.text).toContain("Transcript entry: result-uuid");
  });

  test("uses UTF-8 bytes rather than characters for the decision", () => {
    const f = fixture({ text: "é".repeat(READ_STUB_THRESHOLD / 2 + 1) });
    const stub = stubKeptReads(f.messages, f.transcript)[2]!.toolResults![0]!.text;
    expect(stub).toContain("16386 UTF-8 bytes");
    expect(stub).toContain(`SHA-256: ${createHash("sha256").update(f.text, "utf8").digest("hex")}`);
  });

  test.each([
    ["Bash", { tool: "Bash", input: { command: "printf large" } }],
    ["failed Read", { error: true }],
    ["Read with offset", { input: { file_path: "docs/guide.md", offset: 1 } }],
    ["Read with limit", { input: { file_path: "docs/guide.md", limit: 999 } }],
    ["Read with page selection", { input: { file_path: "docs/guide.pdf", pages: "1-5" } }],
    ["image metadata", { resultMeta: { type: "image" } }],
    ["image inside result", { resultContent: [{ type: "text", text: "x".repeat(32_000) }, { type: "image", source: {} }] }],
    ["image beside result", { extraBlock: { type: "image", source: {} } }],
    ["truncated whole-file Read", { resultMeta: { type: "text", file: { startLine: 1, numLines: 10, totalLines: 11 } } }],
    ["no Read call in tail", { callInTail: false }],
    ["path too large for a recoverable stub", { input: { file_path: "x".repeat(READ_STUB_MAX_BYTES) } }],
  ] as [string, Options][])("leaves %s untouched", (_name, options) => {
    const f = fixture(options);
    const out = stubKeptReads(f.messages, f.transcript);
    expect(out).toEqual(f.messages);
    out.forEach((message, index) => expect(message).toBe(f.messages[index]!));
  });

  test("does not trust a handle absent or ambiguous in the transcript", () => {
    const f = fixture();
    expect(stubKeptReads(f.messages, JSON.stringify(f.rows[0]))).toEqual(f.messages);
    expect(() => stubKeptReads(f.messages, `${f.transcript}\n${JSON.stringify(f.rows[1])}`)).toThrow("duplicate transcript uuid");
  });

  test("does not stub a sidechain result that history.expand cannot address", () => {
    const f = fixture();
    const rows = [f.rows[0], { ...f.rows[1], isSidechain: true }];
    expect(stubKeptReads(f.messages, rows.map((row) => JSON.stringify(row)).join("\n"))).toEqual(f.messages);
  });

  test("leaves duplicate results and a result before its call unchanged", () => {
    const f = fixture();
    const duplicate = [...f.messages, f.messages[2]!];
    expect(stubKeptReads(duplicate, f.transcript)).toEqual(duplicate);
    const reversed = [f.messages[0]!, f.messages[2]!, f.messages[1]!];
    expect(stubKeptReads(reversed, f.transcript)).toEqual(reversed);
  });

  test("does not modify a result when the stored text disagrees", () => {
    const f = fixture({ resultContent: "a different result" });
    expect(stubKeptReads(f.messages, f.transcript)).toEqual(f.messages);
  });
});
