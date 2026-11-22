import { expect, spyOn, test } from "bun:test";
import * as renderer from "../../src/compaction/render.ts";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compact } from "../../src/compaction/compact.ts";
import { rebuildTranscript } from "../../src/compaction/from-transcript.ts";
import { buildKeptReadStub, READ_STUB_MAX_BYTES, READ_STUB_THRESHOLD, stubKeptReads } from "../../src/compaction/kept-read.ts";
import { keptReadStub } from "../../src/compaction/verified/generated/kept-read-stub.js";
import type { ClaudeMessage, ClaudeToolUse } from "../../src/compaction/from-claude.ts";
import { register } from "../../src/mod/index.ts";
import { expand, recall } from "../../src/recall/history.ts";

type Row = { type: string; uuid?: string; parentUuid?: string | null; logicalParentUuid?: string | null;
  subtype?: string; compactMetadata?: object; isCompactSummary?: boolean; toolUseResult?: unknown; message?: { id?: string; content: unknown } };
type Event = { trigger: "manual" | "auto" | "plugin" | "precompute"; messages: ClaudeMessage[]; instructions?: string; agentId?: string };
type Handler = (dollar: unknown, event: Event, next: (event: Event) => unknown) => unknown;

const message = (role: "user" | "assistant", text: string, handle: string): ClaudeMessage =>
  ({ role, text, toolUses: [], handle });
const row = (m: ClaudeMessage, parentUuid: string | null): Row =>
  ({ type: m.role, uuid: m.handle, parentUuid, message: { content: m.text } });

async function inProject<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fabric-compact-rebuild-"));
  const prior = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = dir;
  try { return await run(dir); }
  finally {
    if (prior === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  }
}

function hook(path: string) {
  let handler: Handler | undefined;
  const on = (topic: string, candidate: Handler) => {
    if (topic === "session.compact") handler = candidate;
    return { catch: () => undefined };
  };
  register(on as never, {} as never);
  if (!handler) throw new Error("missing session.compact hook");
  const invoke = handler;
  const calls: Event[] = [];
  const logs: string[] = [];
  const logTargets: (string | undefined)[] = [];
  const reads: { offset?: number; length?: number; as?: string }[] = [];
  const dollar = {
    session: { info: async () => ({ transcriptPath: path }) },
    fs: {
      stat: async (name: string) => ({ size: (await stat(name)).size }),
      read: async (name: string, options?: { offset?: number; length?: number; as?: string }) => {
        reads.push(options ?? {});
        const bytes = await readFile(name);
        const part = bytes.subarray(options?.offset ?? 0, (options?.offset ?? 0) + (options?.length ?? bytes.length));
        return options?.as === "bytes" ? { base64: part.toString("base64") } : part.toString("utf8");
      },
    },
    ui: { log: (line: string, options?: { to?: string }) => { logs.push(line); logTargets.push(options?.to); } },
  };
  return {
    calls, logs, logTargets, reads,
    run: async (event: Event) => await invoke(dollar, event, (e) => {
      calls.push(e);
      return { messages: [message("user", "core summary", "core")] };
    }) as { messages?: ClaudeMessage[]; skip?: string },
  };
}

const writeRows = async (path: string, rows: Row[]) =>
  writeFile(path, rows.map((item) => JSON.stringify(item)).join("\n") + "\n");

test("kept whole-file Read result is a recoverable stub without changing its summary or call", async () => {
  await inProject(async (dir) => {
    const path = join(dir, "read.jsonl");
    const text = "text from the whole file\n".repeat(1400);
    const first = message("user", `Original. ${"x".repeat(70000)}`, "first");
    const prompt = message("user", "Read the guide.", "prompt");
    const call: ClaudeMessage = { ...message("assistant", "", "call"), toolUses: [{ tool_use_id: "read-1", tool: "Read", input: { file_path: "docs/guide.md" }, text }] };
    const result: ClaudeMessage = { ...message("user", "", "result-uuid"), toolResults: [{ tool_use_id: "read-1", text, isError: false }] };
    const last = message("assistant", "Read it.", "last");
    await writeRows(path, [row(first, null), row(prompt, "first"),
      { type: "assistant", uuid: "call", parentUuid: "prompt", message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "docs/guide.md" } }] } },
      { type: "user", uuid: "result-uuid", parentUuid: "call", toolUseResult: { type: "text", file: { startLine: 1, numLines: 1400, totalLines: 1400 } }, message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: text }] } }, row(last, "result-uuid")]);
    const messages = [first, prompt, call, result, last];
    const baseline = compact(messages);
    if (!("messages" in baseline)) throw new Error(JSON.stringify(baseline));
    const output = await hook(path).run({ trigger: "manual", messages });
    expect(output.messages?.[0]?.text).toBe(baseline.messages[0]!.text);
    const keptCall = output.messages?.find((m) => m.handle === "call");
    expect(keptCall).toEqual(call);
    expect(output.messages).toHaveLength(baseline.messages.length);
    for (let index = 1; index < baseline.messages.length; index++) {
      const before = baseline.messages[index]!;
      if (before !== result) expect(output.messages![index]).toBe(before);
      else {
        const { handle, toolResults, ...unchanged } = before;
        expect(handle).toBe("result-uuid");
        const { handle: newHandle, toolResults: newResults, ...after } = output.messages![index]!;
        expect(newHandle).toBeUndefined();
        expect(after).toEqual(unchanged);
        expect({ ...newResults![0], text: toolResults![0]!.text }).toEqual(toolResults![0]);
      }
    }
    const stub = output.messages?.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === "read-1");
    expect(stub?.text.length).toBeLessThan(1024);
    expect(stub?.text).toContain("docs/guide.md");
    expect(stub?.text).toContain(String(text.length));
    expect(stub?.text).toContain("result-uuid");
    expect(stub?.text).not.toContain("history.expand");
    expect(stub?.text).toContain("call Read on the file with no offset or limit");
    const id = /^Transcript entry: (.+)$/m.exec(stub!.text)?.[1];
    expect(id).toBe("result-uuid");
    const { binding } = await recall(path, { query: "guide" });
    let args = { binding, entryIds: [id!] };
    let recovered = "";
    for (;;) {
      const page = await expand(path, args);
      recovered += page.entries.map((entry) => entry.text).join("");
      if (!page.next) break;
      args = page.next as typeof args;
    }
    expect(recovered).toBe(`toolResult: ${text}`);
    const prior = { ...baseline.messages[0]!, handle: "prior-summary" };
    const later = hook(path);
    const rebuilt = await later.run({ trigger: "manual", messages: [prior, prompt, call, result, last] });
    expect(later.logs).toEqual([]);
    expect(rebuilt.messages?.[0]?.text).toBe(baseline.messages[0]!.text);
    expect(rebuilt.messages?.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === "read-1")?.text).toBe(stub?.text);
    await rm(path);
    const unavailable = hook(path);
    const unchanged = await unavailable.run({ trigger: "manual", messages });
    expect(unchanged.messages).toEqual(baseline.messages);
    expect(unavailable.logs[0]).toContain("could not verify kept Read for stubbing");
  });
});

test("the compiled decision requires each emitted and verified fact", () => {
  const facts = { original: 32000, stub: 200, threshold: READ_STUB_THRESHOLD, cap: READ_STUB_MAX_BYTES,
    namesPath: 1, namesBytes: 1, namesEntry: 1, namesDigest: 1, recoverable: 1, verifiedCall: 1 };
  const decide = (input: typeof facts) => keptReadStub.step({}, keptReadStub.init({}), input).scalars["out.replace"];
  expect(decide(facts)).toBe(1);
  for (const key of ["namesPath", "namesBytes", "namesEntry", "namesDigest", "recoverable", "verifiedCall"] as const) {
    expect(decide({ ...facts, [key]: 0 })).toBe(0);
  }
});

test("stub verification requires the non-sidechain matching call and names an escaped path", () => {
  const path = "docs/quote\"and\nnewline.md", text = "x".repeat(32000), input = { file_path: path };
  const call: ClaudeMessage = { ...message("assistant", "", "call"), toolUses: [{ tool_use_id: "t1", tool: "Read", input, text }] };
  const result: ClaudeMessage = { ...message("user", "", "result"), toolResults: [{ tool_use_id: "t1", text, isError: false }] };
  const messages = [message("user", "[Fabric summary]", "summary"), call, result];
  const callRow = { type: "assistant", uuid: "call", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input }] } };
  const resultRow = { type: "user", uuid: "result", toolUseResult: { type: "text", file: { startLine: 1, numLines: 1, totalLines: 1 } },
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: text }] } };
  const transcript = (rows: object[]) => rows.map((row) => JSON.stringify(row)).join("\n");
  const stub = stubKeptReads(messages, transcript([callRow, resultRow]))[2]!.toolResults![0]!.text;
  expect(stub).toContain(`\nFile: ${JSON.stringify(path)}\n`);
  expect(stub).toContain(`whole file: ${Buffer.byteLength(text)} UTF-8 bytes`);
  expect(stub).toContain("\nTranscript entry: result\n");
  const parsedRows = new Map<string, Record<string, unknown>>([["call", callRow], ["result", resultRow]]);
  expect(stubKeptReads(messages, parsedRows)[2]!.toolResults![0]!.text).toBe(stub);
  expect(stubKeptReads(messages, new Map<string, Record<string, unknown>>([["call", callRow], ["result", { ...resultRow, isSidechain: true }]]))).toEqual(messages);
  expect(stubKeptReads(messages, transcript([resultRow]))).toEqual(messages);
  expect(stubKeptReads(messages, transcript([{ ...callRow, isSidechain: true }, resultRow]))).toEqual(messages);
  const wrong = { ...callRow, message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "elsewhere" } }] } };
  expect(stubKeptReads(messages, transcript([wrong, resultRow]))).toEqual(messages);
});

test.each(["both", "copy-only"])("a stubbed Read survives the next full-transcript rebuild (%s)", async (shape) => {
  await inProject(async (dir) => {
    const path = join(dir, "two-compactions.jsonl");
    const first = message("user", `Original request ${"x".repeat(70000)}`, "first");
    const prompt = message("user", "Read the first guide.", "prompt");
    const oldInput = { file_path: "docs/old.md" };
    const oldText = "FIRST-ORIGINAL-CONTENT\n".repeat(1500);
    const oldCall: ClaudeMessage = { ...message("assistant", "", "old-call"), toolUses: [{ tool_use_id: "old-read", tool: "Read", input: oldInput, text: oldText }] };
    const oldResult: ClaudeMessage = { ...message("user", "", "11111111-1111-4111-8111-111111111111"), toolResults: [{ tool_use_id: "old-read", text: oldText, isError: false }] };
    const done = message("assistant", "First read complete.", "old-done");
    const callRow = (uuid: string, parentUuid: string, id: string, input: object): Row =>
      ({ type: "assistant", uuid, parentUuid, message: { content: [{ type: "tool_use", id, name: "Read", input }] } });
    const resultRow = (uuid: string, parentUuid: string, id: string, text: string): Row =>
      ({ type: "user", uuid, parentUuid, toolUseResult: { type: "text", file: { startLine: 1, numLines: 1, totalLines: 1 } },
        message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
    const originalRows = [row(first, null), row(prompt, "first"), callRow("old-call", "prompt", "old-read", oldInput),
      resultRow("11111111-1111-4111-8111-111111111111", "old-call", "old-read", oldText), row(done, "11111111-1111-4111-8111-111111111111")];
    await writeRows(path, originalRows);
    const n = hook(path);
    const firstMessages = [first, prompt, oldCall, oldResult, done];
    const firstOutput = await n.run({ trigger: "manual", messages: firstMessages });
    const firstMain = compact(firstMessages);
    if (!("messages" in firstMain)) throw new Error("expected first main summary");
    expect(firstOutput.messages?.[0]?.text).toBe(firstMain.messages[0]!.text);
    const stub = firstOutput.messages?.flatMap(m => m.toolResults ?? []).find(r => r.tool_use_id === "old-read")?.text;
    expect(n.logs).toEqual([]);
    expect(stub).toContain("Transcript entry: 11111111-1111-4111-8111-111111111111");
    const prior = { ...firstOutput.messages![0]!, handle: "summary" };
    const copiedCall: ClaudeMessage = { ...message("assistant", "", "copy-call"), toolUses: [{ tool_use_id: "old-read", tool: "Read", input: oldInput, text: stub! }] };
    const copiedResult: ClaudeMessage = { ...message("user", "", "22222222-2222-4222-8222-222222222222"), toolResults: [{ tool_use_id: "old-read", text: stub!, isError: false }] };
    const padding = message("user", `Intervening work ${"y".repeat(70000)}`, "padding");
    const nextPrompt = message("user", "Read the next guide.", "next-prompt");
    const freshInput = { file_path: "docs/new.md" }, freshText = "SECOND-ORIGINAL-CONTENT\n".repeat(1500);
    const freshCall: ClaudeMessage = { ...message("assistant", "", "fresh-call"), toolUses: [{ tool_use_id: "fresh-read", tool: "Read", input: freshInput, text: freshText }] };
    const freshResult: ClaudeMessage = { ...message("user", "", "33333333-3333-4333-8333-333333333333"), toolResults: [{ tool_use_id: "fresh-read", text: freshText, isError: false }] };
    const last = message("assistant", "Second read complete.", "last");
    await writeRows(path, [...originalRows,
      { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: null, logicalParentUuid: "old-done", compactMetadata: {} },
      row(prior, "boundary"), callRow("copy-call", "summary", "old-read", oldInput),
      resultRow("22222222-2222-4222-8222-222222222222", shape === "both" ? "copy-call" : "old-call", "old-read", stub!),
      row(padding, "22222222-2222-4222-8222-222222222222"), row(nextPrompt, "padding"), callRow("fresh-call", "next-prompt", "fresh-read", freshInput),
      resultRow("33333333-3333-4333-8333-333333333333", "fresh-call", "fresh-read", freshText), row(last, "33333333-3333-4333-8333-333333333333")]);
    const messages = [prior, copiedCall, copiedResult, padding, nextPrompt, freshCall, freshResult, last];
    // A mid-session upgrade leaves the old public format without a content commitment.
    const legacy = stub!.replace(/\nSHA-256: [a-f0-9]{64}/, "");
    const recorded = await readFile(path, "utf8");
    await writeFile(path, recorded.replaceAll(JSON.stringify(stub), JSON.stringify(legacy)));
    const legacyMessages = [prior, { ...copiedCall, toolUses: [{ ...copiedCall.toolUses[0]!, text: legacy }] },
      { ...copiedResult, toolResults: [{ ...copiedResult.toolResults![0]!, text: legacy }] }, padding, nextPrompt, freshCall, freshResult, last];
    const upgrade = hook(path);
    const upgraded = await upgrade.run({ trigger: "manual", messages: legacyMessages });
    // Here the chain has no conflicting effective outcomes: the legacy stub stays
    // plain text and the rebuilt summary can quote it without a fallback.
    expect(upgrade.logs).toEqual([]);
    expect(upgraded.messages?.[0]?.text).toContain(legacy.slice(0, 55));
    expect(upgraded.messages?.[0]?.text).not.toContain("FIRST-ORIGINAL-CONTENT");
    await writeFile(path, recorded);
    const next = hook(path);
    const output = await next.run({ trigger: "manual", messages });
    expect(next.logs).toEqual([]);
    expect(output.messages?.[0]?.text).not.toContain("[Earlier summary]");
    const rebuilt = rebuildTranscript(messages, await readFile(path, "utf8"));
    const oldBodies = rebuilt.flatMap(m => [...m.toolUses.filter(u => u.tool_use_id === "old-read" && u.text !== undefined).map(u => u.text),
      ...(m.toolResults ?? []).filter(r => r.tool_use_id === "old-read").map(r => r.text)]);
    expect(oldBodies).toContain(oldText);
    expect(oldBodies.includes(stub)).toBe(false);
    const transcript = await readFile(path, "utf8");
    const mainMessages = [prior, { ...copiedCall, toolUses: [{ ...copiedCall.toolUses[0]!, text: oldText }] },
      { ...copiedResult, toolResults: [{ ...copiedResult.toolResults![0]!, text: oldText }] },
      padding, nextPrompt, freshCall, freshResult, last];
    const mainText = transcript.replace(JSON.stringify(stub), JSON.stringify(oldText));
    const main = compact(rebuildTranscript(mainMessages, mainText));
    if (!("messages" in main)) throw new Error("expected main summary");
    expect(output.messages?.[0]?.text).toBe(main.messages[0]!.text.replaceAll("22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"));
    const expected = compact(rebuilt);
    if (!("messages" in expected)) throw new Error("expected rebuilt summary");
    expect(output.messages?.[0]?.text).toBe(expected.messages[0]!.text);
    expect(output.messages?.[0]?.text).not.toContain(stub!.slice(0, 55));
    expect(output.messages?.[0]?.text).toContain("FIRST-ORIGINAL-CONTENT");
    // The copy contains only the stub; an excerpt must address the original row.
    expect(output.messages?.[0]?.text).not.toContain("[entry 22222222-2222-4222-8222-222222222222] → ok: FIRST-ORIGINAL-CONTENT");
    expect(output.messages?.[0]?.text).toContain("[entry 11111111-1111-4111-8111-111111111111] → ok: FIRST-ORIGINAL-CONTENT");
    const resultRows = rebuilt.filter((m) => m.toolResults?.some((r) => r.tool_use_id === "old-read"));
    expect(resultRows).toHaveLength(shape === "both" ? 2 : 1);
    expect(resultRows.map((m) => m.handle ?? m.uuid)).toEqual(shape === "both" ? ["11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111"] : ["11111111-1111-4111-8111-111111111111"]);
    const { binding } = await recall(path, { query: "old.md" });
    let expandArgs = { binding, entryIds: ["11111111-1111-4111-8111-111111111111"] };
    let expanded = "";
    for (;;) {
      const page = await expand(path, expandArgs);
      expanded += page.entries.map((entry) => entry.text).join("");
      if (!page.next) break;
      expandArgs = page.next as typeof expandArgs;
    }
    expect(expanded).toBe(`toolResult: ${oldText}`);
    const freshStub = output.messages?.flatMap(m => m.toolResults ?? []).find(r => r.tool_use_id === "fresh-read")?.text;
    expect(freshStub).toContain("Transcript entry: 33333333-3333-4333-8333-333333333333");

    // Feed the second output back through a second physical kept copy.
    const prior2 = { ...output.messages![0]!, handle: "summary2" };
    const copy2Call: ClaudeMessage = { ...message("assistant", "", "copy2-call"), toolUses: [
      { tool_use_id: "fresh-read", tool: "Read", input: freshInput, text: freshStub! },
    ] };
    const copy2Result: ClaudeMessage = { ...message("user", "", "44444444-4444-4444-8444-444444444444"),
      toolResults: [{ tool_use_id: "fresh-read", text: freshStub!, isError: false }] };
    const padding2 = message("user", `More work ${"z".repeat(70000)}`, "padding2");
    const thirdPrompt = message("user", "Read the third guide.", "prompt3");
    const thirdInput = { file_path: "docs/third.md" }, thirdText = "THIRD-ORIGINAL-CONTENT\n".repeat(1500);
    const thirdCall: ClaudeMessage = { ...message("assistant", "", "call3"), toolUses: [
      { tool_use_id: "third-read", tool: "Read", input: thirdInput, text: thirdText },
    ] };
    const thirdResult: ClaudeMessage = { ...message("user", "", "55555555-5555-4555-8555-555555555555"),
      toolResults: [{ tool_use_id: "third-read", text: thirdText, isError: false }] };
    const last3 = message("assistant", "Third read complete.", "last3");
    const moreRows = [
      { type: "system", subtype: "compact_boundary", uuid: "boundary2", parentUuid: null, logicalParentUuid: "last", compactMetadata: {} },
      row(prior2, "boundary2"), callRow("copy2-call", "summary2", "fresh-read", freshInput),
      resultRow("44444444-4444-4444-8444-444444444444", shape === "both" ? "copy2-call" : "fresh-call", "fresh-read", freshStub!),
      row(padding2, "44444444-4444-4444-8444-444444444444"), row(thirdPrompt, "padding2"), callRow("call3", "prompt3", "third-read", thirdInput),
      resultRow("55555555-5555-4555-8555-555555555555", "call3", "third-read", thirdText), row(last3, "55555555-5555-4555-8555-555555555555"),
    ];
    const transcript3 = transcript + moreRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await writeFile(path, transcript3);
    const current3 = [prior2, copy2Call, copy2Result, padding2, thirdPrompt, thirdCall, thirdResult, last3];
    const thirdHook = hook(path);
    const output3 = await thirdHook.run({ trigger: "manual", messages: current3 });
    expect(thirdHook.logs).toEqual([]);
    const mainText3 = transcript3.replaceAll(JSON.stringify(stub), JSON.stringify(oldText))
      .replaceAll(JSON.stringify(freshStub), JSON.stringify(freshText));
    const mainMessages3 = [prior2, { ...copy2Call, toolUses: [{ ...copy2Call.toolUses[0]!, text: freshText }] },
      { ...copy2Result, toolResults: [{ ...copy2Result.toolResults![0]!, text: freshText }] },
      padding2, thirdPrompt, thirdCall, thirdResult, last3];
    const main3 = compact(rebuildTranscript(mainMessages3, mainText3));
    if (!("messages" in main3)) throw new Error("expected third main summary");
    expect(output3.messages?.[0]?.text).toBe(main3.messages[0]!.text
      .replaceAll("22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111").replaceAll("44444444-4444-4444-8444-444444444444", "33333333-3333-4333-8333-333333333333"));
    expect(output3.messages?.[0]?.text).not.toContain(freshStub!.slice(0, 55));
    expect(output3.messages?.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === "third-read")?.text)
      .toContain("Transcript entry: 55555555-5555-4555-8555-555555555555");
  });
});

test("a genuine fallback honestly summarizes a stub before transcript resolution", async () => {
  const stub = buildKeptReadStub("docs/old.md", "original-result", "x".repeat(33_000));
  const call: ClaudeMessage = { ...message("assistant", "", "copied-call"), toolUses: [
    { tool_use_id: "old-read", tool: "Read", input: { file_path: "docs/old.md" }, text: stub },
  ] };
  const result: ClaudeMessage = { ...message("user", "", "copied-result"),
    toolResults: [{ tool_use_id: "old-read", text: stub, isError: false }] };
  const event: Event = { trigger: "manual", messages: [message("user", "[Fabric summary]\nEarlier.", "summary"),
    call, result, message("user", `New work ${"x".repeat(80000)}`, "last")] };
  const carried = compact(event.messages);
  if (!("messages" in carried)) throw new Error("expected carry");
  const h = hook("");
  const fallback = await h.run(event);
  expect(fallback).toEqual(carried);
  expect(h.logs[0]).toContain("no transcript path");
  const preview = Array.from(stub.split("\n")[0]!).slice(0, 99).join("");
  expect(fallback.messages![0]!.text.split("\n").find((line) => line.includes(preview)))
    .toBe(`[entry copied-result] → ok: ${preview}… [4 lines, ${Array.from(stub).length - 99} chars cut; history.expand]`);
});

test("a genuine rebuild conflict carries the unchanged result without stubbing", async () => {
  await inProject(async (dir) => {
    const path = join(dir, "recorded-conflict.jsonl");
    const prior = message("user", "[Fabric summary]\nEarlier work.", "summary");
    const earlier = message("user", "[Fabric summary]\nEarlier still.", "earlier-summary");
    const first = message("user", "Original request.", "first");
    const oldText = "old guide text\n".repeat(2200);
    const oldStub = buildKeptReadStub("docs/old.md", "old-result", "x".repeat(33_000)).replace(/\nSHA-256: [a-f0-9]{64}/, "");
    const oldInput = { file_path: "docs/old.md" };
    const padding = message("user", `Earlier work ${"x".repeat(70000)}`, "padding");
    const prompt = message("user", "Read the next guide in full.", "prompt");
    const text = "fresh guide text\n".repeat(1900);
    const input = { file_path: "docs/guide-2.md" };
    const call: ClaudeMessage = { ...message("assistant", "", "call"),
      toolUses: [{ tool_use_id: "fresh-read", tool: "Read", input, text }] };
    const result: ClaudeMessage = { ...message("user", "", "result"),
      toolResults: [{ tool_use_id: "fresh-read", text, isError: false }] };
    const last = message("assistant", "Read it.", "last");
    const callRow = (uuid: string, parentUuid: string, id: string, data: object): Row =>
      ({ type: "assistant", uuid, parentUuid, message: { content: [{ type: "tool_use", id, name: "Read", input: data }] } });
    const resultRow = (uuid: string, parentUuid: string, id: string, value: string): Row =>
      ({ type: "user", uuid, parentUuid, toolUseResult: { type: "text", file: { startLine: 1, numLines: 1, totalLines: 1 } },
        message: { content: [{ type: "tool_result", tool_use_id: id, content: value }] } });
    await writeRows(path, [row(first, null), callRow("old-call", "first", "old-read", oldInput),
      resultRow("old-result", "old-call", "old-read", oldText),
      { type: "system", subtype: "compact_boundary", uuid: "boundary-1", parentUuid: null, logicalParentUuid: "old-result", compactMetadata: {} },
      row(earlier, "boundary-1"),
      callRow("copy-call", "earlier-summary", "old-read", oldInput), resultRow("copy-result", "copy-call", "old-read", oldStub),
      { type: "system", subtype: "compact_boundary", uuid: "boundary-2", parentUuid: null, logicalParentUuid: "copy-result", compactMetadata: {} },
      row(prior, "boundary-2"), row(padding, "summary"), row(prompt, "padding"), callRow("call", "prompt", "fresh-read", input),
      resultRow("result", "call", "fresh-read", text), row(last, "result")]);
    const messages = [prior, padding, prompt, call, result, last];
    const carried = compact(messages);
    if (!("messages" in carried)) throw new Error("expected carried summary");
    const h = hook(path);
    const output = await h.run({ trigger: "manual", messages });
    expect(h.logs[0]).toContain("conflicting tool outcome id");
    expect(output.messages?.[0]?.text).toBe(carried.messages[0]!.text);
    const kept = output.messages?.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === "fresh-read");
    expect(kept?.text).toBe(text);
    expect(kept?.text.length).toBeGreaterThan(1024);
    const { binding } = await recall(path, { query: "guide" });
    let args = { binding, entryIds: ["result"] };
    let recovered = "";
    for (;;) {
      const page = await expand(path, args);
      recovered += page.entries.map((entry) => entry.text).join("");
      if (!page.next) break;
      args = page.next as typeof args;
    }
    expect(recovered).toBe(`toolResult: ${text}`);
  });
});

test("later compaction rebuilds parallel sibling tool failures instead of carrying the summary", async () => {
  await inProject(async (dir) => {
    const path = join(dir, "sibling.jsonl");
    const prior = message("user", `[Fabric summary]\nEarlier work. ${"p".repeat(9000)}`, "summary");
    const first = message("user", `Original request. ${"o".repeat(9000)}`, "first");
    const uses = [
      { tool_use_id: "a", tool: "Read", input: { file_path: "a.txt" } },
      { tool_use_id: "b", tool: "Read", input: { file_path: "b.txt" } },
    ];
    const calls: ClaudeMessage[] = uses.map((use) => ({ role: "assistant", text: "", toolUses: [use], handle: `rewritten-${use.tool_use_id}` }));
    const sibling: ClaudeMessage = { role: "user", text: "", toolUses: [], handle: "sibling",
      toolResults: [{ tool_use_id: "a", text: "SIBLING-FAILURE", isError: true }] };
    const onChain: ClaudeMessage = { role: "user", text: "", toolUses: [], handle: "chain-result",
      toolResults: [{ tool_use_id: "b", text: "CHAIN-FAILURE", isError: true }] };
    const last = message("user", `LAST ${"x".repeat(75000)}`, "last");
    await writeRows(path, [row(first, null),
      { type: "assistant", uuid: "original-a", parentUuid: "first", message: { id: "parallel", content: [
        { type: "tool_use", id: "a", name: "Read", input: uses[0]!.input }] } },
      { type: "assistant", uuid: "original-b", parentUuid: "original-a", message: { id: "parallel", content: [
        { type: "tool_use", id: "b", name: "Read", input: uses[1]!.input }] } },
      { type: "user", uuid: "sibling", parentUuid: "original-a", message: { content: [
        { type: "tool_result", tool_use_id: "a", content: "SIBLING-FAILURE", is_error: true }] } },
      { type: "user", uuid: "chain-result", parentUuid: "original-b", message: { content: [
        { type: "tool_result", tool_use_id: "b", content: "CHAIN-FAILURE", is_error: true }] } },
      row(last, "chain-result")]);
    const event: Event = { trigger: "manual", messages: [prior, ...calls, sibling, onChain, last] };
    const carried = compact(event.messages);
    if (!("messages" in carried)) throw new Error("expected the current messages to compact");
    expect(carried.messages[0]!.text).toContain("SIBLING-FAILURE");
    expect(carried.messages[0]!.text).toContain("CHAIN-FAILURE");
    const h = hook(path);
    const result = await h.run(event);
    expect(h.calls).toEqual([]);
    expect(result.messages?.[0]?.text).toContain("CHAIN-FAILURE");
    expect(result.messages?.[0]?.text).toContain("SIBLING-FAILURE");
    expect(result.messages?.[0]?.text).toContain("Original request.");
    expect(result.messages?.[0]?.text).not.toContain("[Earlier summary]");
    expect(h.logs).toEqual([]);
    expect(h.logTargets).toEqual([]);
  });
});

test("a duplicated success after a restored failure falls back to the current event", async () => {
  await inProject(async (dir) => {
    const path = join(dir, "duplicate-success.jsonl");
    const prior = message("user", `[Fabric summary]\nEarlier work. ${"p".repeat(9000)}`, "summary");
    const first = message("user", `Original request. ${"o".repeat(9000)}`, "first");
    const edit = (id: string) => ({ tool_use_id: id, tool: "Edit", input: { file_path: "same.txt" } });
    const read = { tool_use_id: "c", tool: "Read", input: { file_path: "other.txt" } };
    const call = (handle: string, use: ClaudeToolUse): ClaudeMessage =>
      ({ role: "assistant", text: "", toolUses: [use], handle });
    const result = (handle: string, id: string, text: string, isError = false): ClaudeMessage =>
      ({ ...message("user", "", handle), toolResults: [{ tool_use_id: id, text, isError }] });
    const earlier = call("copy-earlier", { ...edit("earlier"), text: "OK" });
    const earlierResult = result("copy-earlier-result", "earlier", "OK");
    const a = call("copy-a", edit("a")), c = call("copy-c", read);
    const sibling = result("sibling-a", "a", "FAILED", true);
    const joined = result("joined", "c", "C");
    joined.toolResults!.push({ tool_use_id: "earlier", text: "OK", isError: false });
    const last = message("user", `LAST ${"x".repeat(75000)}`, "last");
    const toolRow = (uuid: string, parentUuid: string, use: ClaudeToolUse, id: string): Row =>
      ({ type: "assistant", uuid, parentUuid, message: { id, content: [
        { type: "tool_use", id: use.tool_use_id, name: use.tool, input: use.input },
      ] } });
    const resultRow = (uuid: string, parentUuid: string, entries: NonNullable<ClaudeMessage["toolResults"]>): Row =>
      ({ type: "user", uuid, parentUuid, message: { content: entries.map((entry) => ({
        type: "tool_result", tool_use_id: entry.tool_use_id, content: entry.text, is_error: entry.isError,
      })) } });
    await writeRows(path, [row(first, null), toolRow("call-earlier", "first", edit("earlier"), "earlier-group"),
      resultRow("result-earlier", "call-earlier", earlierResult.toolResults!),
      toolRow("call-a", "result-earlier", edit("a"), "parallel"), toolRow("call-c", "call-a", read, "parallel"),
      resultRow("sibling-a", "call-a", sibling.toolResults!), resultRow("joined", "call-c", joined.toolResults!),
      row(last, "joined")]);
    const event: Event = { trigger: "manual", messages: [prior, earlier, earlierResult, a, c, sibling, joined, last] };
    const carried = compact(event.messages);
    if (!("messages" in carried)) throw new Error("expected the current messages to compact");
    expect(carried.messages[0]!.text).toContain("same.txt: FAILED");
    const h = hook(path);
    const output = await h.run(event);
    expect(output).toEqual(carried);
    expect(output.messages?.[0]?.text).toContain("same.txt: FAILED");
    expect(h.calls).toEqual([]);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("missing tool outcome in rebuilt input");
    expect(h.logTargets).toEqual(["debug"]);
  });
});

test("a conflicting rebuilt outcome falls back with one debug reason", async () => {
  await inProject(async (dir) => {
    const path = join(dir, "conflict.jsonl");
    const prior = message("user", `[Fabric summary]\nEarlier work. ${"p".repeat(9000)}`, "summary");
    const first = message("user", `Original. ${"o".repeat(9000)}`, "first");
    const use = { tool_use_id: "a", tool: "Read", input: { file_path: "a.txt" } };
    const call: ClaudeMessage = { role: "assistant", text: "", handle: "rewritten-call",
      toolUses: [{ ...use, text: "CURRENT-FAILURE", isError: true }] };
    const answer: ClaudeMessage = { role: "user", text: "", toolUses: [], handle: "answer",
      toolResults: [{ tool_use_id: "a", text: "TRANSCRIPT-FAILURE", isError: true }] };
    const last = message("user", `LAST ${"x".repeat(75000)}`, "last");
    await writeRows(path, [row(first, null),
      { type: "assistant", uuid: "original-call", parentUuid: "first", message: { content: [
        { type: "tool_use", id: use.tool_use_id, name: use.tool, input: use.input }] } },
      { type: "user", uuid: "answer", parentUuid: "original-call", message: { content: [
        { type: "tool_result", tool_use_id: "a", content: "TRANSCRIPT-FAILURE", is_error: true }] } },
      row(last, "answer")]);
    const event: Event = { trigger: "manual", messages: [prior, call, answer, last] };
    const h = hook(path);
    const result = await h.run(event);
    expect(result).toEqual(compact(event.messages));
    expect(result.messages?.[0]?.text).toContain("CURRENT-FAILURE");
    expect(result.messages?.[0]?.text).not.toContain("TRANSCRIPT-FAILURE");
    expect(h.calls).toEqual([]);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("conflicting tool outcome id");
    expect(h.logTargets).toEqual(["debug"]);
  });
});

test("a matching result without its known tool use falls back", async () => {
  await inProject(async (dir) => {
    const path = join(dir, "orphan.jsonl");
    const prior = message("user", `[Fabric summary]\nEarlier work. ${"p".repeat(9000)}`, "summary");
    const first = message("user", `Original. ${"o".repeat(9000)}`, "first");
    const call: ClaudeMessage = { role: "assistant", text: "", handle: "rewritten-call",
      toolUses: [{ tool_use_id: "a", tool: "Read", input: { file_path: "a.txt" }, text: "ORPHANED-FAILURE", isError: true }] };
    const answer: ClaudeMessage = { role: "user", text: "", toolUses: [], handle: "answer",
      toolResults: [{ tool_use_id: "a", text: "ORPHANED-FAILURE", isError: true }] };
    const last = message("user", `LAST ${"x".repeat(75000)}`, "last");
    await writeRows(path, [row(first, null),
      { type: "user", uuid: "answer", parentUuid: "first", message: { content: [
        { type: "tool_result", tool_use_id: "a", content: "ORPHANED-FAILURE", is_error: true }] } },
      row(last, "answer")]);
    const event: Event = { trigger: "manual", messages: [prior, call, answer, last] };
    const h = hook(path);
    const result = await h.run(event);
    expect(result).toEqual(compact(event.messages));
    expect(result.messages?.[0]?.text).toContain("ORPHANED-FAILURE");
    expect(h.calls).toEqual([]);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("rebuilt input has no tool use");
    expect(h.logTargets).toEqual(["debug"]);
  });
});

test("a rebuild with matching inline and row outcomes is still accepted", async () => {
  await inProject(async (dir) => {
    const path = join(dir, "matched.jsonl");
    const prior = message("user", `[Fabric summary]\nEarlier work. ${"p".repeat(9000)}`, "summary");
    const first = message("user", `REBUILT-FIRST-FACT ${"o".repeat(9000)}`, "first");
    const use = { tool_use_id: "a", tool: "Read", input: { file_path: "a.txt" } };
    const call: ClaudeMessage = { role: "assistant", text: "", handle: "rewritten-call",
      toolUses: [{ ...use, text: "MATCHED-FAILURE", isError: true }] };
    const answer: ClaudeMessage = { role: "user", text: "", toolUses: [], handle: "answer",
      toolResults: [{ tool_use_id: "a", text: "MATCHED-FAILURE", isError: true }] };
    const last = message("user", `LAST ${"x".repeat(75000)}`, "last");
    await writeRows(path, [row(first, null),
      { type: "assistant", uuid: "original-call", parentUuid: "first", message: { content: [
        { type: "tool_use", id: use.tool_use_id, name: use.tool, input: use.input }] } },
      { type: "user", uuid: "answer", parentUuid: "original-call", message: { content: [
        { type: "tool_result", tool_use_id: "a", content: "MATCHED-FAILURE", is_error: true }] } },
      row(last, "answer")]);
    const h = hook(path);
    const result = await h.run({ trigger: "manual", messages: [prior, call, answer, last] });
    expect(result.messages?.[0]?.text).toContain("REBUILT-FIRST-FACT");
    expect(result.messages?.[0]?.text).toContain("MATCHED-FAILURE");
    expect(result.messages?.[0]?.text).not.toContain("[Earlier summary]");
    expect(h.calls).toEqual([]);
    expect(h.logs).toEqual([]);
  });
});

test("the registered hook extracts assistant values behind a summary-shaped heading", async () => {
  const assistant: ClaudeMessage = {
    role: "assistant", handle: "assistant-source",
    text: "[Fabric summary]\nCreated tools/migrate_v3_alpha.py for BATCH-5c1e8a0b77d2.",
    toolUses: [{ tool_use_id: "inline", tool: "Bash", input: {}, text: "RESULT-12ab34cd" }],
  };
  const h = hook("");
  const result = await h.run({ trigger: "manual", messages: [
    message("user", `Inspect. ${"older context ".repeat(300)}`, "first"), assistant,
    message("user", `Next. ${"x".repeat(79000)}`, "last"),
  ] });
  expect(result.messages).toBeDefined();
  const section = result.messages?.[0]?.text.split("[Exact values]\n")[1]?.split("\n\n")[0] ?? "";
  expect(section).toContain("[entry assistant-source] tools/migrate_v3_alpha.py");
  expect(section).toContain("[entry assistant-source] BATCH-5c1e8a0b77d2");
  expect(section).toContain("[entry assistant-source] RESULT-12ab34cd");
  expect(h.calls).toEqual([]);
  expect(h.reads).toEqual([]);
});

test("the registered hook preserves a sampled-out user host and port", async () => {
  const messages: ClaudeMessage[] = [];
  for (let i = 0; i < 100; i++) {
    const text = i === 40 ? "Our endpoint is maple.example.test on port 7274." : `Review ${i}: ${"ordinary details ".repeat(60)}`;
    messages.push(message("user", text, `user-${i}`), message("assistant", "Noted.", `assistant-${i}`));
  }
  messages.push(message("user", `Final prompt ${"x".repeat(79000)}`, "last"));
  const h = hook("");
  const result = await h.run({ trigger: "manual", messages });
  const section = result.messages?.[0]?.text.split("[Exact values]\n")[1]?.split("\n\n")[0] ?? "";
  expect(section).toContain("[entry user-40] Our endpoint is maple.example.test on port 7274.");
  expect(h.calls).toEqual([]);
});

test("a later hook-answered compaction rebuilds the first user fact without the rewritten tail", async () => {
  await inProject(async (dir) => {
    const path = join(dir, "session.jsonl");
    const fact = "FIRST-USER-RELEASE-VERSION-8.4.2";
    const first = message("user", `Keep this release fact: ${fact}.`, "first");
    const old = [message("user", "ORIGINAL-KEPT-TAIL", "old-u"), message("assistant", "Old reply.", "old-a")];
    const prior = message("user", `[Fabric summary]\n\n${"a".repeat(8000)}${fact}${"b".repeat(21000)}`, "summary");
    const rewritten = [message("user", old[0]!.text, "rewrite-u"), message("assistant", old[1]!.text, "rewrite-a")];
    const fresh: ClaudeMessage[] = [];
    for (let i = 0; i < 7; i++) {
      fresh.push(message("user", `New request ${i}: ${"u".repeat(2500)}`, `u${i}`));
      fresh.push(message("assistant", `New response ${i}: ${"a".repeat(4000)}`, `a${i}`));
    }
    fresh.push(message("user", `LAST-PROMPT ${"x".repeat(75000)}`, "last"));
    const rows: Row[] = [row(first, null), row(old[0]!, "first"), row(old[1]!, "old-u"),
      { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: "old-a", compactMetadata: {} },
      { ...row(prior, "boundary"), isCompactSummary: true },
      row(rewritten[0]!, "summary"), row(rewritten[1]!, "rewrite-u")];
    let parent = "old-a";
    for (const item of fresh) { rows.push(row(item, parent)); parent = item.handle!; }
    await writeRows(path, rows);
    const event: Event = { trigger: "manual", instructions: "Keep details. ".repeat(300),
      messages: [prior, ...rewritten, ...fresh] };
    const carried = compact(event.messages, { instructions: event.instructions });
    if (!("messages" in carried)) throw new Error(`carry did not compact: ${JSON.stringify(carried)}`);
    expect(carried.messages[0]!.text).toContain("from the middle of the earlier summary");
    expect(carried.messages[0]!.text).not.toContain(fact);
    const h = hook(path);
    const result = await h.run(event);
    expect(result.messages?.[0]?.text).toContain(fact);
    expect(result.messages?.[0]?.text).not.toContain("[Earlier summary]");
    expect(result.messages?.map((item) => item.text).join("\n")).not.toContain("[entry rewrite-u]");
    expect(result.messages?.map((item) => item.text).join("\n")).not.toContain("[entry rewrite-a]");
    // A single entry appears once per projection, though separate sections may quote it.
    expect(result.messages?.[0]?.text.match(/User \[entry old-u\]:/g)?.length).toBe(1);
    expect(result.messages?.[0]?.text.match(/\[entry old-u\] user:/g)?.length).toBe(1);
    expect(h.calls).toEqual([]);
  });
});

test("the active chain crosses a core boundary through logicalParentUuid", async () => {
  await inProject(async (dir) => {
    const path = join(dir, "core.jsonl");
    const initial = message("user", "CORE-CHAIN-FIRST-FACT", "first");
    const reply = message("assistant", "Done.", "reply");
    const coreSummary = message("user", "Core's own summary.", "core-sum");
    const joinMessage = message("user", `JOINED-REQUEST ${"j".repeat(7000)}`, "join");
    const last = message("user", `LAST ${"x".repeat(75000)}`, "last");
    await writeRows(path, [row(initial, null), row(reply, "first"),
      { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: null, logicalParentUuid: "reply" },
      { ...row(coreSummary, "boundary"), isCompactSummary: true }, row(joinMessage, "core-sum"), row(last, "join")]);
    const previous = message("user", "[Fabric summary]\n\nOld Fabric summary.", "fabric-sum");
    const rewritten = message("user", "OFF-CHAIN-REWRITE", "rewrite");
    const h = hook(path);
    const result = await h.run({ trigger: "manual", messages: [previous, rewritten, joinMessage, last] });
    expect(result.messages?.[0]?.text).toContain("CORE-CHAIN-FIRST-FACT");
    expect(result.messages?.[0]?.text).toContain("Core's own summary.");
    expect(result.messages?.[0]?.text).not.toContain("OFF-CHAIN-REWRITE");
    expect(result.messages?.[0]?.text).not.toContain("[Earlier summary]");
    expect(h.calls).toEqual([]);
    expect(h.logs).toEqual([]);
  });
});

for (const carry of [false, true]) test(`G: auto compaction returns its genuinely wrong ${carry ? "carried" : "initial"} candidate`, async () => {
  const original = renderer.renderSummaryWithMetadata;
  const spy = spyOn(renderer, "renderSummaryWithMetadata").mockImplementation((sections, options) => {
    const candidate = original(sections, options);
    return { ...candidate, summary: candidate.summary.replace("Recover full context in fabric_exec with history.recall and history.expand.", "[missing footer]") };
  });
  try {
    const prior = message("user", "[Fabric summary]\nEarlier.", "summary");
    const first = message("user", "Original request.", "first");
    const event: Event = { trigger: "auto", messages: [...(carry ? [prior] : []), first, message("user", `LAST ${"x".repeat(81000)}`, "last")] };
    const h = hook("");
    const result = await h.run(event);
    expect(result.messages?.[0]?.text).toContain("[missing footer]");
    expect(h.calls).toEqual([]);
    expect(h.logs[0]).toContain("summary QA refused: recall footer");
    expect(h.logTargets).toEqual(carry ? ["debug", "debug"] : ["debug"]);
    if (carry) expect(h.logs[1]).toContain("no transcript path");
  } finally { spy.mockRestore(); }
});

for (const trigger of ["manual", "auto"] as const) test(`R3-5: ${trigger} rebuilds after only the carried candidate fails QA`, async () => {
  await inProject(async (dir) => {
    const path = join(dir, "good-rebuild.jsonl");
    const first = message("user", "Original request.", "first");
    const joinMessage = message("user", "Continue.", "join");
    const last = message("user", `LAST ${"x".repeat(81000)}`, "last");
    await writeRows(path, [row(first, null), row(joinMessage, "first"), row(last, "join")]);
    const event: Event = { trigger, messages: [message("user", "[Fabric summary]\n\nPRESERVED CARRY", "summary"), joinMessage, last] };
    const original = renderer.renderSummaryWithMetadata;
    const spy = spyOn(renderer, "renderSummaryWithMetadata").mockImplementation((sections, options) => {
      const candidate = original(sections, options);
      return !options.earlierSummary ? candidate : { ...candidate, summary: candidate.summary.replace(
        "Recover full context in fabric_exec with history.recall and history.expand.", "[missing footer]") };
    });
    try {
      const h = hook(path);
      const result = await h.run(event);
      expect(result.messages?.[0]?.text).toContain("Original request.");
      expect(result.messages?.[0]?.text).not.toContain("[missing footer]");
      expect(h.reads.length).toBeGreaterThan(0);
      expect(h.logs[0]).toContain("summary QA refused: recall footer");
      expect(h.logTargets).toEqual(["debug"]);
      expect(h.calls).toEqual([]);
    } finally { spy.mockRestore(); }
  });
});

for (const trigger of ["manual", "auto"] as const) test(`R3-both: ${trigger} returns the refused rebuild when the carry was also refused`, async () => {
  await inProject(async (dir) => {
    const path = join(dir, "both-bad.jsonl");
    const first = message("user", "Original request.", "first");
    const joinMessage = message("user", "Continue.", "join");
    const last = message("user", `LAST ${"x".repeat(81000)}`, "last");
    await writeRows(path, [row(first, null), row(joinMessage, "first"), row(last, "join")]);
    const event: Event = { trigger, messages: [message("user", "[Fabric summary]\n\nPRESERVED CARRY", "summary"), joinMessage, last] };
    const original = renderer.renderSummaryWithMetadata;
    const spy = spyOn(renderer, "renderSummaryWithMetadata").mockImplementation((sections, options) => {
      const candidate = original(sections, options);
      const marker = options.earlierSummary ? "[bad carry]" : "[bad rebuild]";
      return { ...candidate, summary: candidate.summary.replace("Recover full context in fabric_exec with history.recall and history.expand.", marker) };
    });
    try {
      const h = hook(path);
      const result = await h.run(event);
      expect(result.messages?.[0]?.text).toContain("[bad rebuild]");
      expect(result.messages?.[0]?.text).not.toContain("[bad carry]");
      expect(h.logs.filter((line) => line.includes("summary QA refused: recall footer"))).toHaveLength(2);
      expect(h.logTargets).toEqual(["debug", "debug"]);
      expect(h.calls).toEqual([]);
    } finally { spy.mockRestore(); }
  });
});

test("E: a rebuilt failed edit with a clipped long path is admitted", async () => {
  await inProject(async (dir) => {
    const path = join(dir, "qa-refusal.jsonl");
    const first = message("user", "Original request.", "first");
    const longPath = `src/${"p".repeat(1200)}.txt`;
    const joinMessage = message("user", "Continue.", "join");
    const last = message("user", `LAST ${"x".repeat(81000)}`, "last");
    await writeRows(path, [row(first, null),
      { type: "assistant", uuid: "call", parentUuid: "first", message: { content: [
        { type: "tool_use", id: "edit", name: "Edit", input: { file_path: longPath } }] } },
      { type: "user", uuid: "answer", parentUuid: "call", message: { content: [
        { type: "tool_result", tool_use_id: "edit", content: "permission denied", is_error: true }] } },
      row(joinMessage, "answer"), row(last, "join")]);
    const event: Event = { trigger: "manual", messages: [message("user", "[Fabric summary]\n\nPRESERVED CARRY", "summary"), joinMessage, last] };
    const carried = compact(event.messages);
    expect("messages" in carried).toBe(true);
    const h = hook(path);
    const result = await h.run(event);
    expect(result.messages?.[0]?.text).toContain("Original request.");
    expect(result.messages?.[0]?.text).toContain("- Edit src/");
    expect(result.messages?.[0]?.text).not.toContain(longPath);
    expect(h.calls).toEqual([]);
    expect(h.logs).toEqual([]);
  });
});

test("G: a genuinely wrong rebuilt candidate falls back to the carried summary", async () => {
  await inProject(async (dir) => {
    const path = join(dir, "bad-rebuild.jsonl");
    const first = message("user", "Original request.", "first");
    const joinMessage = message("user", "Continue.", "join");
    const last = message("user", `LAST ${"x".repeat(81000)}`, "last");
    await writeRows(path, [row(first, null), row(joinMessage, "first"), row(last, "join")]);
    const event: Event = { trigger: "auto", messages: [message("user", "[Fabric summary]\n\nPRESERVED CARRY", "summary"), joinMessage, last] };
    const carried = compact(event.messages);
    expect("messages" in carried).toBe(true);
    const original = renderer.renderSummaryWithMetadata;
    const spy = spyOn(renderer, "renderSummaryWithMetadata").mockImplementation((sections, options) => {
      const candidate = original(sections, options);
      return options.firstEntryId !== "first" ? candidate : { ...candidate, summary: candidate.summary.replace(
        "Recover full context in fabric_exec with history.recall and history.expand.", "[missing footer]") };
    });
    try {
      const h = hook(path);
      const result = await h.run(event);
      expect(result).toEqual(carried);
      expect(h.calls).toEqual([]);
      expect(h.logs[0]).toContain("summary QA refused: recall footer");
      expect(h.logTargets).toEqual(["debug"]);
    } finally { spy.mockRestore(); }
  });
});

const fallbackEvent = (): Event => ({ trigger: "manual", messages: [
  message("user", "[Fabric summary]\n\nPRESERVED-CARRY-FACT", "summary"),
  message("user", `Some earlier work ${"a".repeat(5000)}`, "older"),
  message("user", `LAST ${"x".repeat(79000)}`, "last"),
] });

test("a single long turn after a Fabric summary still hands the original event to core", async () => {
  const event: Event = { trigger: "auto", messages: [message("user", "[Fabric summary]\nearlier", "summary"),
    message("user", "One long task.", "task"), message("assistant", "x".repeat(200000), "reply")] };
  const h = hook("");
  const result = await h.run(event);
  expect(result.messages?.[0]?.text).toBe("core summary");
  expect(h.calls).toEqual([event]);
  expect(h.reads).toEqual([]);
  expect(h.logs).toEqual([]);
});

test("a subagent compaction never reads the main conversation's transcript", async () => {
  await inProject(async (dir) => {
    const event = { ...fallbackEvent(), agentId: "agent-1" };
    const carried = compact(event.messages);
    const h = hook(join(dir, "main.jsonl"));
    expect(await h.run(event)).toEqual(carried);
    expect(h.reads).toEqual([]);
    expect(h.logs[0]).toContain("compacting agent has no transcript path");
    expect(h.logTargets).toEqual(["debug"]);
  });
});

test("a rebuild that would skip still uses the original carry instead of vetoing compaction", async () => {
  await inProject(async (dir) => {
    const path = join(dir, "short-chain.jsonl");
    const event = fallbackEvent();
    await writeRows(path, [row(message("user", "Short original.", "first"), null), row(event.messages[2]!, "first")]);
    const carried = compact(event.messages);
    if (!("messages" in carried)) throw new Error("expected the original input to compact");
    const h = hook(path);
    expect(await h.run(event)).toEqual(carried);
    expect(h.logs[0]).toContain("rebuilt input did not produce a summary");
    expect(h.logTargets).toEqual(["debug"]);
    expect(h.calls).toEqual([]);
  });
});

test.each(["missing path", "unreadable file", "malformed JSONL", "broken chain", "invalid parent", "no join"])(
  "%s falls back to the unchanged carry with a debug reason", async (kind) => {
    await inProject(async (dir) => {
      let path = join(dir, "session.jsonl");
      if (kind === "missing path") path = "";
      else if (kind === "unreadable file") path = dir; // stat succeeds; read rejects a directory.
      else if (kind === "malformed JSONL") await writeFile(path, "{bad json\n");
      else if (kind === "broken chain") await writeRows(path, [row(message("user", "leaf", "last"), "absent-parent")]);
      else if (kind === "invalid parent") await writeFile(path, JSON.stringify({ type: "user", uuid: "last", parentUuid: 42, message: { content: "leaf" } }) + "\n");
      else await writeRows(path, [row(message("user", "other chain", "other"), null)]);
      const event = fallbackEvent();
      const carried = compact(event.messages);
      if (!("messages" in carried)) throw new Error(`expected a carry summary: ${JSON.stringify(carried)}`);
      const h = hook(path);
      const result = await h.run(event);
      expect(result).toEqual(carried);
      expect(result.messages?.[0]?.text).toContain("[Fabric summary]");
      expect(result.messages?.[0]?.text).toContain("[Earlier summary]");
      expect(result.messages?.[0]?.text).toContain("PRESERVED-CARRY-FACT");
      expect(h.calls).toEqual([]);
      expect(h.logs).toHaveLength(1);
      expect(h.logTargets).toEqual(["debug"]);
      const expected = kind === "missing path" ? "no transcript path" : kind === "unreadable file" ? "EISDIR"
        : kind === "malformed JSONL" ? "invalid transcript JSON" : kind === "broken chain" ? "parent uuid absent-parent is missing"
        : kind === "invalid parent" ? "parent of last is invalid" : "no current message handle joins";
      expect(h.logs[0]).toContain(expected);
    });
  },
);

test("a rebuilt result that would retain handle-less transcript rows returns the carry", async () => {
  await inProject(async (dir) => {
    const path = join(dir, "retained.jsonl");
    const first = message("user", `Old task ${"x".repeat(100000)}`, "first");
    const old = message("user", "Retained original.", "old-u");
    const response = message("assistant", "Original reply.", "old-a");
    const joined = message("user", "New prompt.", "join");
    await writeRows(path, [row(first, null), row(old, "first"), row(response, "old-u"), row(joined, "old-a")]);
    const event: Event = { trigger: "manual", messages: [message("user", "[Fabric summary]\nprevious", "summary"),
      message("user", "rewritten", "rewrite"), joined] };
    const carried = compact(event.messages);
    const h = hook(path);
    const result = await h.run(event);
    expect(result).toEqual(carried);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("without engine handles");
    expect(h.logTargets).toEqual(["debug"]);
    expect(h.calls).toEqual([]);
  });
});

test("ranged byte reads preserve Unicode split across the 2 MiB boundary", async () => {
  await inProject(async (dir) => {
    const path = join(dir, "unicode.jsonl");
    const initial = { type: "user", uuid: "first", parentUuid: null, padding: "", message: { content: "🦊 SPLIT-UNICODE-FACT" } };
    const empty = JSON.stringify(initial);
    const before = Buffer.byteLength(empty.slice(0, empty.indexOf("🦊")));
    initial.padding = "x".repeat(2 * 1024 * 1024 - 2 - before);
    const serialized = JSON.stringify(initial);
    expect(Buffer.byteLength(serialized.slice(0, serialized.indexOf("🦊")))).toBe(2 * 1024 * 1024 - 2);
    const joined = message("user", `join ${"y".repeat(7000)}`, "join");
    const last = message("user", `last ${"z".repeat(75000)}`, "last");
    await writeFile(path, [serialized, JSON.stringify(row(joined, "first")), JSON.stringify(row(last, "join"))].join("\n") + "\n");
    const h = hook(path);
    const result = await h.run({ trigger: "manual", messages: [message("user", "[Fabric summary]\nold", "sum"),
      message("user", "rewritten", "rewrite"), joined, last] });
    expect(result.messages?.[0]?.text).toContain("🦊 SPLIT-UNICODE-FACT");
    expect(h.reads.length).toBeGreaterThan(1);
    expect(h.reads.every((read) => read.as === "bytes" && (read.length ?? Infinity) <= 2 * 1024 * 1024)).toBe(true);
    expect(h.logs).toEqual([]);
  });
});

test("ten hook-answered compactions rebuild a growing chain and stay below the summary ceiling", async () => {
  await inProject(async (dir) => {
    const path = join(dir, "endurance.jsonl");
    const rows: Row[] = [];
    const first = message("user", "TEN-CYCLE-FIRST-FACT", "first");
    rows.push(row(first, null));
    let parent = "first";
    let prior: ClaudeMessage | undefined;
    let rewritten: ClaudeMessage[] = [];
    const sizes: number[] = [];
    for (let cycle = 0; cycle < 10; cycle++) {
      const fresh = [message("user", `Cycle ${cycle}`, `u${cycle}`),
        message("assistant", `Work ${cycle}. ${"w".repeat(84000)}`, `a${cycle}`),
        message("user", `Ready ${cycle}`, `ready${cycle}`)];
      for (const item of fresh) { rows.push(row(item, parent)); parent = item.handle!; }
      await writeRows(path, rows);
      const h = hook(path);
      const current = prior ? [prior, ...rewritten, ...fresh] : [first, ...fresh];
      const result = await h.run({ trigger: "manual", messages: current });
      if (!result.messages) throw new Error(`cycle ${cycle} did not compact: ${JSON.stringify(result)}`);
      const summary = result.messages[0]!.text;
      sizes.push(Buffer.byteLength(summary));
      expect(summary).toContain("TEN-CYCLE-FIRST-FACT");
      expect(summary).not.toContain("[Earlier summary]");
      expect(h.calls).toEqual([]);
      expect(h.logs).toEqual([]);
      const summaryId = `summary${cycle}`;
      rows.push({ type: "system", subtype: "compact_boundary", uuid: `boundary${cycle}`, parentUuid: parent, compactMetadata: {} });
      prior = message("user", summary, summaryId);
      rows.push({ ...row(prior, `boundary${cycle}`), isCompactSummary: true });
      let rewriteParent = summaryId;
      rewritten = result.messages.slice(1).map((item, index) => {
        const copy = { ...item, handle: `rewrite${cycle}-${index}` };
        rows.push(row(copy, rewriteParent));
        rewriteParent = copy.handle;
        return copy;
      });
      // Claude parents the next prompt to the original kept row, not the rewritten copy.
    }
    expect(sizes).toHaveLength(10);
    expect(Math.max(...sizes)).toBeLessThan(25000);
    expect(Math.max(...sizes.slice(4)) - Math.min(...sizes.slice(4))).toBeLessThan(8000);
  });
});
