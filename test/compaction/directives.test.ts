import { expect, test } from "bun:test";
import { compact } from "../../src/compaction/compact.ts";
import { MAX_SUMMARY_BYTES, utf8Bytes } from "../../src/compaction/bounds.ts";
import type { ClaudeMessage } from "../../src/compaction/from-claude.ts";

const user = (text: string, handle: string): ClaudeMessage => ({ role: "user", text, handle, toolUses: [] });
const assistant = (handle: string): ClaudeMessage => ({ role: "assistant", text: "Noted.", handle, toolUses: [] });

const summarized = (messages: ClaudeMessage[]): string => {
  const result = compact(messages, { keepRecentTokens: 1 });
  if (!("messages" in result)) throw new Error(JSON.stringify(result));
  return result.messages[0]!.text;
};

test("under omission pressure later short directions survive and lost messages are disclosed", () => {
  const messages: ClaudeMessage[] = [];
  const add = (text: string) => {
    const n = messages.length;
    messages.push(user(text, `user-${n}`), assistant(`assistant-${n}`));
  };
  add("Use the copper theme.");
  for (let i = 0; i < 38; i++) add(`Filler ${i.toString().padStart(3, "0")}: ${"lengthy background ".repeat(24)}`);
  add("Change the theme to silver.");
  add("Sort results by name.");
  add("Keep disabled rows in the output.");
  for (let i = 38; i < 94; i++) add(`Filler ${i.toString().padStart(3, "0")}: ${"lengthy background ".repeat(24)}`);
  add("Final tail.");
  const summary = summarized(messages);
  const earlier = summary.split("[Earlier user messages]")[1]?.split("[Recent user directions and discussion]")[0] ?? "";
  expect(earlier).toContain("Change the theme to silver.");
  expect(earlier).toContain("Sort results by name.");
  expect(earlier).toContain("Keep disabled rows in the output.");
  expect(earlier).toMatch(/… omitted \d+ user messages; source entries [^\n]+/);
  expect(utf8Bytes(summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
});

test("repeated prompts do not displace distinct longer user rules", () => {
  const messages: ClaudeMessage[] = [];
  const add = (text: string) => {
    const n = messages.length;
    messages.push(user(text, `u-${n}`), assistant(`a-${n}`));
  };
  const longRule = `A distinct rule: retain every disabled row and mark it inactive. ${"More detail. ".repeat(12)}`;
  add(longRule);
  for (let i = 0; i < 90; i++) add(`Repeated background ${i % 4}.`);
  add("Final tail.");
  const summary = summarized(messages);
  const earlier = summary.split("[Earlier user messages]")[1]?.split("[Recent user directions and discussion]")[0] ?? "";
  expect(earlier).toContain(longRule);
  expect(earlier).toMatch(/… omitted \d+ user messages; source entries [^\n]+/);
  expect(utf8Bytes(summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
});

test("equal-length entries prefer newer user messages and name the loss", () => {
  const messages: ClaudeMessage[] = [];
  for (let i = 0; i < 100; i++) {
    const body = i === 0 ? "Old choice: copper." : i === 40 ? "New choice: silver." : `Background ${i.toString().padStart(3, "0")}.`;
    messages.push(user(body.padEnd(48, " "), `u-${i}`), assistant(`a-${i}`));
  }
  messages.push(user("Final tail.", "tail"));
  const summary = summarized(messages);
  const earlier = summary.split("[Earlier user messages]")[1]?.split("[Recent user directions and discussion]")[0] ?? "";
  expect(earlier).not.toContain("Old choice: copper.");
  expect(earlier).toContain("New choice: silver.");
  expect(earlier).toMatch(/… omitted \d+ user messages; source entries [^\n]+/);
});

test("omission notice survives when long user messages exhaust the byte budget", () => {
  const messages: ClaudeMessage[] = [];
  for (let i = 0; i < 85; i++) {
    const body = i === 0 ? "Use the copper theme." : `Long entry ${i}: ${"x".repeat(6000)}`;
    messages.push(user(body, `u-${i}`), assistant(`a-${i}`));
  }
  messages.push(user("Final tail.", "tail"));
  const summary = summarized(messages);
  const earlier = summary.split("[Earlier user messages]")[1]?.split("[Recent user directions and discussion]")[0] ?? "";
  expect(earlier).toContain("Use the copper theme.");
  expect(earlier).toContain("later directives may be omitted");
  expect(earlier).toMatch(/… omitted \d+ user messages; source entries u-\d+ → u-\d+ \(not necessarily consecutive\)/);
  expect(earlier).toMatch(/\[omitted \d+ UTF-8 bytes of u-\d+\]/);
  expect(utf8Bytes(summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
});

test("a later long correction takes priority over older short turns", () => {
  const messages: ClaudeMessage[] = [];
  const longCorrection = `Change the earlier choice to silver. ${"Additional context. ".repeat(8)}`;
  for (let i = 0; i < 100; i++) {
    const body = i === 0 ? "Use copper." : i === 50 ? longCorrection : `Note ${i.toString().padStart(3, "0")}.`;
    messages.push(user(body, `u-${i}`), assistant(`a-${i}`));
  }
  messages.push(user("Final tail.", "tail"));
  const summary = summarized(messages);
  const earlier = summary.split("[Earlier user messages]")[1]?.split("[Recent user directions and discussion]")[0] ?? "";
  expect(earlier).toContain(longCorrection);
  expect(earlier).not.toContain("Use copper.");
  expect(earlier).toMatch(/… omitted \d+ user messages; source entries [^\n]+/);
});
