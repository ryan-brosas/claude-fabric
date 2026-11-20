import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expand, recall } from "../../src/recall/history.ts";
import { acceptsExpansionPage } from "../../src/recall/page.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const make = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-recall-")); dirs.push(dir);
  const path = join(dir, "session.jsonl");
  await writeFile(path, await readFile(new URL("./fixtures/chain.jsonl", import.meta.url)));
  return path;
};

test("a tool-result hit expands from the bound prefix after the transcript grows", async () => {
  const path = await make();
  const result = await recall(path, { query: "ALMANAC-493" });
  expect(result.hits).toHaveLength(1);
  await appendFile(path, JSON.stringify({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { content: [{ type: "text", text: "New turn" }] } }) + "\n");
  const page = await expand(path, result.hits[0]!.follow);
  expect(page.entries[0]!.text).toContain("ALMANAC-493");
});

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
