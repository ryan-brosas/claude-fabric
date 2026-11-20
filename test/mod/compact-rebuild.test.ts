import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compact } from "../../src/compaction/compact.ts";
import type { ClaudeMessage } from "../../src/compaction/from-claude.ts";
import { register } from "../../src/mod/index.ts";

type Row = { type: string; uuid?: string; parentUuid?: string | null; logicalParentUuid?: string | null;
  subtype?: string; compactMetadata?: object; isCompactSummary?: boolean; message?: { content: unknown } };
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

test("later compaction falls back when rebuilding loses a parallel tool failure", async () => {
  await inProject(async (dir) => {
    const path = join(dir, "sibling.jsonl");
    const prior = message("user", `[Fabric summary]\nEarlier work. ${"p".repeat(9000)}`, "summary");
    const first = message("user", `Original request. ${"o".repeat(9000)}`, "first");
    const uses = [
      { tool_use_id: "a", tool: "Read", input: { file_path: "a.txt" } },
      { tool_use_id: "b", tool: "Read", input: { file_path: "b.txt" } },
    ];
    const call: ClaudeMessage = { role: "assistant", text: "", toolUses: uses, handle: "rewritten-call" };
    const sibling: ClaudeMessage = { role: "user", text: "", toolUses: [], handle: "sibling",
      toolResults: [{ tool_use_id: "a", text: "SIBLING-FAILURE", isError: true }] };
    const onChain: ClaudeMessage = { role: "user", text: "", toolUses: [], handle: "chain-result",
      toolResults: [{ tool_use_id: "b", text: "CHAIN-FAILURE", isError: true }] };
    const last = message("user", `LAST ${"x".repeat(75000)}`, "last");
    await writeRows(path, [row(first, null),
      { type: "assistant", uuid: "original-call", parentUuid: "first", message: { content: uses.map((use) =>
        ({ type: "tool_use", id: use.tool_use_id, name: use.tool, input: use.input })) } },
      { type: "user", uuid: "sibling", parentUuid: "original-call", message: { content: [
        { type: "tool_result", tool_use_id: "a", content: "SIBLING-FAILURE", is_error: true }] } },
      { type: "user", uuid: "chain-result", parentUuid: "original-call", message: { content: [
        { type: "tool_result", tool_use_id: "b", content: "CHAIN-FAILURE", is_error: true }] } },
      row(last, "chain-result")]);
    const event: Event = { trigger: "manual", messages: [prior, call, sibling, onChain, last] };
    const carried = compact(event.messages);
    if (!("messages" in carried)) throw new Error("expected the current messages to compact");
    expect(carried.messages[0]!.text).toContain("SIBLING-FAILURE");
    expect(carried.messages[0]!.text).toContain("CHAIN-FAILURE");
    const h = hook(path);
    const result = await h.run(event);
    expect(h.calls).toEqual([]);
    expect(result.messages?.[0]?.text).toContain("CHAIN-FAILURE");
    expect(result.messages?.[0]?.text).toContain("SIBLING-FAILURE");
    expect(result).toEqual(carried);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("missing tool outcome");
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
