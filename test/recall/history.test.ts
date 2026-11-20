import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expand, recall } from "../../src/recall/history.ts";
import { acceptsExpansionPage } from "../../src/recall/page.ts";
import { compact } from "../../src/compaction/compact.ts";
import { fromTranscript } from "../../src/compaction/from-transcript.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const make = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-recall-")); dirs.push(dir);
  const path = join(dir, "session.jsonl");
  await writeFile(path, await readFile(new URL("./fixtures/chain.jsonl", import.meta.url)));
  return path;
};

test("a rewritten off-chain copy expands its own exact text and UUID across pages", async () => {
  const path = await make();
  const body = "same original 🦊 and copied tool output ".repeat(8);
  const text = `toolResult: ${body}`;
  const result = (toolUseId: string) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: body }] });
  const rows = [
    { type: "user", uuid: "original-1", parentUuid: null, message: result("call-1") },
    { type: "user", uuid: "original-2", parentUuid: "original-1", message: result("call-2") },
    { type: "user", uuid: "copy", parentUuid: "original-1", message: result("rewritten-call") },
    { type: "user", uuid: "active", parentUuid: "original-2", isCompactSummary: true,
      message: { role: "user", content: "[Fabric summary]\n[entry copy] copied tool output" } },
  ];
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const { binding } = await recall(path, { query: "summary" });
  const identical = await expand(path, { binding, entryIds: ["original-2", "copy", "original-1"] });
  expect(identical.entries.map((entry) => entry.uuid)).toEqual(["original-1", "original-2", "copy"]);
  expect(identical.entries.map((entry) => entry.text)).toEqual([text, text, text]);
  expect(identical.entries.map((entry) => entry.kind)).toEqual(["tool_result", "tool_result", "tool_result"]);
  let args = { binding, entryIds: ["copy"], maxChars: 17 };
  let rebuilt = "";
  for (;;) {
    const page = await expand(path, args);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.uuid).toBe("copy");
    rebuilt += page.entries[0]!.text;
    if (!page.next) break;
    args = page.next as typeof args;
  }
  expect(rebuilt).toBe(text);
});

test("a quoted tool result in a Fabric summary expands to its result text", async () => {
  const path = await make();
  const quoted = "RESULT-EXCERPT-42";
  const rows = [
    { type: "user", uuid: "prompt", parentUuid: null, message: { content: "Read the record." } },
    { type: "assistant", uuid: "call", parentUuid: "prompt", message: { content: [
      { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "record.txt" } },
    ] } },
    { type: "user", uuid: "result", parentUuid: "call", message: { content: [
      { type: "tool_result", tool_use_id: "read-1", content: quoted },
    ] } },
    { type: "user", uuid: "next", parentUuid: "result", message: { content: "Continue." } },
  ];
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const messages = rows.map(fromTranscript);
  messages[1]!.toolUses[0]!.text = quoted; // session.compact also carries the stored outcome on the call.
  const answer = compact(messages, { keepRecentTokens: 1 });
  if (!("messages" in answer)) throw new Error(`no summary: ${JSON.stringify(answer)}`);
  const summary = answer.messages[0]!.text;
  const line = /^\[entry ([^\]]+)\] → ok: (.+)$/m.exec(summary);
  expect(line?.[2]).toBe(quoted);
  const { binding } = await recall(path, { query: "Continue" });
  const page = await expand(path, { binding, entryIds: [line![1]!] });
  expect(page.entries[0]!.text).toContain(quoted);
});

test("quoted Read and Bash failures resolve to result rows without changing call addresses", async () => {
  const path = await make();
  const readError = "read failed:  file absent";
  const bashError = "command failed:\tmissing executable";
  const rows = [
    { type: "user", uuid: "prompt", parentUuid: null, message: { content: "Check both." } },
    { type: "assistant", uuid: "read-call", parentUuid: "prompt", message: { content: [
      { type: "tool_use", id: "read", name: "Read", input: { file_path: "note.txt" } },
    ] } },
    { type: "user", uuid: "read-result", parentUuid: "read-call", message: { content: [
      { type: "tool_result", tool_use_id: "read", is_error: true, content: readError },
    ] } },
    { type: "assistant", uuid: "bash-call", parentUuid: "read-result", message: { content: [
      { type: "tool_use", id: "bash", name: "Bash", input: { command: "runcheck" } },
    ] } },
    { type: "user", uuid: "bash-result", parentUuid: "bash-call", message: { content: [
      { type: "tool_result", tool_use_id: "bash", is_error: true, content: bashError },
    ] } },
    { type: "user", uuid: "next", parentUuid: "bash-result", message: { content: "Continue." } },
  ];
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const messages = rows.map(fromTranscript);
  for (const [index, text] of [[1, readError], [3, bashError]] as const) {
    messages[index]!.toolUses[0]!.text = text;
    messages[index]!.toolUses[0]!.isError = true;
  }
  const answer = compact(messages, { keepRecentTokens: 1 });
  if (!("messages" in answer)) throw new Error(`no summary: ${JSON.stringify(answer)}`);
  const summary = answer.messages[0]!.text;
  expect(summary).toContain(`[entry read-result] → error: ${readError}`);
  expect(summary).toContain(`Read note.txt: ${readError} [entry read-result]`);
  expect(summary).toContain(`Bash: runcheck: ${bashError} [entry bash-result]`);
  expect(summary).toContain("[entry read-call] Read(note.txt)");
  const { binding } = await recall(path, { query: "Continue" });
  const page = await expand(path, { binding, entryIds: ["read-call", "read-result", "bash-call", "bash-result"] });
  const byId = new Map(page.entries.map((entry) => [entry.uuid, entry.text]));
  expect(byId.get("read-result")).toContain(readError);
  expect(byId.get("bash-result")).toContain(bashError);
  expect(byId.get("read-call")).toContain("Tool: Read(");
  expect(byId.get("bash-call")).toContain("Tool: Bash(");
});

test("an inline failure without a result row is quoted under its call id", async () => {
  const path = await make();
  const rows = [
    { type: "user", uuid: "prompt", parentUuid: null, message: { content: "Read it." } },
    { type: "assistant", uuid: "call", parentUuid: "prompt", message: { content: [
      { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "record.txt" } },
    ] } },
    { type: "user", uuid: "next", parentUuid: "call", message: { content: "Continue." } },
  ];
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const messages = rows.map(fromTranscript);
  messages[1]!.toolUses[0]!.text = "E4471: unavailable source";
  messages[1]!.toolUses[0]!.isError = true;
  const answer = compact(messages, { keepRecentTokens: 1 });
  if (!("messages" in answer)) throw new Error(`no summary: ${JSON.stringify(answer)}`);
  const summary = answer.messages[0]!.text;
  expect(summary).toContain("[entry call] Read(record.txt)");
  expect(summary).toContain("[entry call] → error: E4471: unavailable source");
  expect(summary).toContain("Read record.txt: E4471: unavailable source [entry call]");
  expect(summary).toContain("- [entry call] E4471: unavailable source");
  const { binding } = await recall(path, { query: "Continue" });
  expect((await expand(path, { binding, entryIds: ["call"] })).entries[0]!.text).toContain("Tool: Read(");
});

test("mixed direct IDs retain chain order then request order for off-chain rows", async () => {
  const path = await make();
  const fixture = await readFile(path, "utf8");
  const second = JSON.stringify({ type: "user", uuid: "off-2", parentUuid: "u1", message: { content: "other off-chain" } });
  await writeFile(path, fixture.replace('{"type":"user","uuid":"u2"', `${second}\n{"type":"user","uuid":"u2"`));
  const { binding } = await recall(path, { query: "Continue" });
  expect((await recall(path, { query: "OFF-CHAIN-ONLY" })).hits).toEqual([]);
  const page = await expand(path, { binding, entryIds: ["off-2", "u2", "off", "u1", "off-2", "a1"] });
  expect(page.entries.map((entry) => entry.uuid)).toEqual(["u1", "a1", "u2", "off-2", "off"]);
  expect(page.entries.slice(-2).map((entry) => entry.text)).toEqual(["other off-chain", "OFF-CHAIN-ONLY"]);
  const chainOnly = await expand(path, { binding, entryIds: ["u2", "u1", "a1"] });
  expect(chainOnly.entries.map((entry) => entry.uuid)).toEqual(["u1", "a1", "u2"]);
});

test("off-chain range and context anchors are refused, but active-chain ordering still works", async () => {
  const path = await make();
  const { binding } = await recall(path, { query: "Continue" });
  for (const range of [{ first: "off", last: "u2" }, { first: "u1", last: "off" }]) {
    await expect(expand(path, { binding, range })).rejects.toThrow("use plain entryIds");
  }
  for (const context of [{ before: 1 }, { after: 1 }, { before: 0 }, { after: 0 }]) {
    await expect(expand(path, { binding, entryIds: ["off"], ...context })).rejects.toThrow("use plain entryIds");
  }
  const range = await expand(path, { binding, range: { first: "a1", last: "s1" } });
  expect(range.entries.map((entry) => entry.uuid)).toEqual(["a1", "r1", "s1"]);
  const context = await expand(path, { binding, entryIds: ["r1"], before: 1, after: 1 });
  expect(context.entries.map((entry) => entry.uuid)).toEqual(["a1", "r1", "s1"]);
});

test("direct IDs cannot cross sidechain, missing, post-binding or mutated-prefix boundaries", async () => {
  const path = await make();
  const { binding } = await recall(path, { query: "Continue" });
  await appendFile(path, JSON.stringify({ type: "user", uuid: "later", parentUuid: "u2", message: { content: "LATER-SECRET" } }) + "\n");
  for (const id of ["side", "missing", "later", "b1"]) {
    await expect(expand(path, { binding, entryIds: [id] })).rejects.toThrow("not found in the bound transcript");
  }
  expect((await expand(path, { binding, entryIds: ["off"] })).entries[0]!.text).toBe("OFF-CHAIN-ONLY");
  const current = await readFile(path, "utf8");
  await writeFile(path, current.replace("OFF-CHAIN-ONLY", "CHANGED-SECRET"));
  let error = "";
  try { await expand(path, { binding, entryIds: ["off"] }); } catch (cause) { error = String(cause); }
  expect(error).toContain("transcript prefix changed");
  expect(error).not.toContain("OFF-CHAIN-ONLY");
  expect(error).not.toContain("CHANGED-SECRET");
});

test("a tool-result hit expands from the bound prefix after the transcript grows", async () => {
  const path = await make();
  const result = await recall(path, { query: "ALMANAC-493" });
  expect(result.hits).toHaveLength(1);
  await appendFile(path, JSON.stringify({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { content: [{ type: "text", text: "New turn" }] } }) + "\n");
  const page = await expand(path, result.hits[0]!.follow);
  expect(page.entries[0]!.text).toContain("ALMANAC-493");
});

test.each([["ASCII", "ordinary ".repeat(260)], ["NFKC-expanding", "ﬃ".repeat(2500) + " "]])(
  "an unquoted search finds and previews late text in user and tool-result entries after a %s prefix", async (_label, prefix) => {
    const path = await make();
    const needle = "GARNETTARGET";
    const text = `${prefix}${needle} tail`;
    const rows = [
      { type: "user", uuid: "user-late", parentUuid: null, message: { content: text } },
      { type: "user", uuid: "result-late", parentUuid: "user-late", message: { content: [
        { type: "tool_result", tool_use_id: "read", content: text },
      ] } },
    ];
    await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const found = await recall(path, { query: needle.toLowerCase() });
    expect(found.hits.map((hit) => hit.uuid)).toEqual(["user-late", "result-late"]);
    for (const hit of found.hits) {
      expect(hit.snippet).toContain(needle);
      expect(hit.snippet.length).toBeLessThanOrEqual(482);
      expect((await expand(path, hit.follow)).entries[0]!.text).toContain(needle);
    }
    expect(JSON.stringify(found).length).toBeLessThanOrEqual(30000);
  },
);

test("a quoted recall query matches the normalized phrase in order, then ranks its hits", async () => {
  const path = await make();
  const texts = ["red fox", "fox red", "red swift fox", "red fox red fox", "ＲＥＤ ＦＯＸ"];
  const rows = texts.map((text, i) => JSON.stringify({ type: "user", uuid: `phrase-${i}`,
    parentUuid: i ? `phrase-${i - 1}` : null, message: { content: text } })).join("\n") + "\n";
  await writeFile(path, rows);
  const quoted = await recall(path, { query: '"red fox"' });
  expect(quoted.hits.map((hit) => hit.uuid)).toEqual(["phrase-3", "phrase-0", "phrase-4"]);
  const unquoted = await recall(path, { query: "red fox" });
  expect(unquoted.hits.map((hit) => hit.uuid)).toContain("phrase-1");
  expect(unquoted.hits.map((hit) => hit.uuid)).toContain("phrase-2");
});

test.each([
  ['"---"', ["a3", "a1", "u2", "u0"]],
  ['"🦊"', ["a3", "a1", "u2"]],
])("a wordless quoted phrase %s matches and ranks by provenance then recency", async (query, ids) => {
  const path = await make();
  const entries = [
    { uuid: "u0", type: "user", text: "first ---" },
    { uuid: "a1", type: "assistant", text: "older --- 🦊" },
    { uuid: "u2", type: "user", text: "later --- 🦊" },
    { uuid: "a3", type: "assistant", text: "newest --- 🦊" },
    { uuid: "u4", type: "user", text: "unrelated" },
  ];
  const rows = entries.map((entry, i) => JSON.stringify({ type: entry.type, uuid: entry.uuid,
    parentUuid: i ? entries[i - 1]!.uuid : null, message: { content: entry.text } })).join("\n") + "\n";
  await writeFile(path, rows);
  const result = await recall(path, { query });
  expect(result.hits.map((hit) => hit.uuid)).toEqual(ids);
  expect(result.hits.every((hit) => hit.snippet.includes(query.slice(1, -1)))).toBe(true);
});

test.each(["---", "🦊"])("a late wordless phrase %s appears in its snippet", async (phrase) => {
  const path = await make();
  const text = `${"ordinary ".repeat(90)}${phrase} tail`;
  await writeFile(path, JSON.stringify({ type: "user", uuid: "late-symbol", parentUuid: null, message: { content: text } }) + "\n");
  const result = await recall(path, { query: `"${phrase}"` });
  expect(result.hits.map((hit) => hit.uuid)).toEqual(["late-symbol"]);
  expect(result.hits[0]!.snippet).toContain(phrase);
});

test("an empty quoted phrase is rejected", async () => {
  const path = await make();
  await expect(recall(path, { query: '""' })).rejects.toThrow("quoted phrase must not be empty");
});

test.each([["ASCII", "filler ".repeat(350)], ["NFKC-expanding", "ﬃ".repeat(3000)]])("a late quoted phrase remains searchable after %s prefix", async (_label, prefix) => {
  const path = await make();
  const text = `${prefix} Invoice: RED FOX`;
  await writeFile(path, JSON.stringify({ type: "user", uuid: "late", parentUuid: null, message: { content: text } }) + "\n");
  const result = await recall(path, { query: '"red fox"' });
  expect(result.hits.map((hit) => hit.uuid)).toEqual(["late"]);
  expect(result.hits[0]!.snippet).toContain("RED FOX");
  expect((await expand(path, result.hits[0]!.follow)).entries[0]!.text).toBe(text);
});

test.each([["plain", "x".repeat(600)], ["NFKC-expanding", "ﬃ".repeat(600)]])(
  "a quoted phrase snippet anchors on its actual match after %s decoys", async (_label, filler) => {
    const path = await make();
    const text = `red before fox ${filler} ＲＥＤ ＦＯＸ tail`;
    await writeFile(path, JSON.stringify({ type: "user", uuid: "match", parentUuid: null, message: { content: text } }) + "\n");
    const result = await recall(path, { query: '"red fox"' });
    expect(result.hits.map((hit) => hit.uuid)).toEqual(["match"]);
    expect(result.hits[0]!.snippet).toContain("ＲＥＤ ＦＯＸ");
    expect(text).toContain(result.hits[0]!.snippet.replace(/^…|…$/g, ""));
  },
);

test("a phrase matches inside tokens when the exact normalized text is present", async () => {
  const path = await make();
  const row = { type: "user", uuid: "inside", parentUuid: null, message: { content: "sacred foxes" } };
  await writeFile(path, JSON.stringify(row) + "\n");
  const result = await recall(path, { query: '"red fox"' });
  expect(result.hits.map((hit) => hit.uuid)).toEqual(["inside"]);
});

test("refuses an unknown UUID and a range over the 20-entry cap", async () => {
  const path = await make();
  const rows = Array.from({ length: 25 }, (_, i) => JSON.stringify({ type: "user", uuid: `id-${i}`, parentUuid: i ? `id-${i - 1}` : null, message: { content: `word ${i}` } })).join("\n") + "\n";
  await writeFile(path, rows);
  const { binding } = await recall(path, { query: "word" });
  await expect(expand(path, { binding, entryIds: ["missing"] })).rejects.toThrow("not found");
  await expect(expand(path, { binding, range: { first: "id-0", last: "id-20" } })).rejects.toThrow("20-entry cap");
});

test("bounds recall, context and expansion pages and preserves complete text across continuations", async () => {
  const path = await make();
  const long = 'token ' + '"\\\n'.repeat(12000);
  const rows = Array.from({ length: 65 }, (_, i) => JSON.stringify({ type: "user", uuid: `id-${i}`, parentUuid: i ? `id-${i - 1}` : null, message: { content: i === 32 ? long : `token ${i}` } })).join("\n") + "\n";
  await writeFile(path, rows);
  const result = await recall(path, { query: "token", limit: 500 });
  expect(result.hits).toHaveLength(50);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(30000);
  expect(result.next).not.toBeNull();
  const context = await expand(path, { binding: result.binding, entryIds: ["id-32"], before: 500, after: 500, maxEntries: 500, maxChars: 50000 });
  expect(context.entries.length).toBeLessThanOrEqual(20);
  expect(context.entries[0]!.uuid).toBe("id-12");
  let args = { binding: result.binding, entryIds: ["id-32"], maxChars: 50000 };
  let text = "";
  for (;;) {
    const page = await expand(path, args);
    expect(page.entries.reduce((n, entry) => n + entry.text.length, 0)).toBeLessThanOrEqual(24000);
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(30000);
    text += page.entries.map((entry) => entry.text).join("");
    if (!page.next) break;
    args = page.next as typeof args;
  }
  expect(text).toBe(long);
});

test("expansion page checks the exact source slice and contiguous cursor", () => {
  const source = [{ uuid: "a", parent: null, kind: "user" as const, text: "abcdef", timestamp: null }];
  const record = { uuid: "a", kind: "user" as const, text: "abc", textRange: { start: 0, end: 3, total: 6, complete: false } };
  expect(acceptsExpansionPage([record], source, { position: 0, textOffset: 0 }, { position: 0, textOffset: 3 })).toBe(true);
  expect(acceptsExpansionPage([{ ...record, text: "xxx" }], source, { position: 0, textOffset: 0 }, { position: 0, textOffset: 3 })).toBe(false);
  expect(acceptsExpansionPage([record], source, { position: 0, textOffset: 0 }, { position: 1, textOffset: 0 })).toBe(false);
});

test("a rewritten prefix refuses with expected and actual hashes and no transcript text", async () => {
  const path = await make();
  const result = await recall(path, { query: "ALMANAC-493" });
  const follow = result.hits[0]!.follow;
  const old = await readFile(path, "utf8");
  await writeFile(path, old.replace("ALMANAC-493", "CHANGED-493"));
  let error = "";
  try { await expand(path, follow); } catch (cause) { error = String(cause); }
  expect(error).toContain(follow.binding.sha256);
  expect(error).toMatch(/actual[^a-f0-9]*[a-f0-9]{64}/i);
  expect(error).not.toContain("ALMANAC-493");
  expect(error).not.toContain("CHANGED-493");
});
