import { expect, test } from "bun:test";
import { compact } from "../../src/compaction/compact.ts";
import { MAX_SUMMARY_BYTES, utf8Bytes } from "../../src/compaction/bounds.ts";
import type { ClaudeMessage, CompactionEvent } from "../../src/compaction/from-claude.ts";
import { projectWithMetadata } from "../../src/compaction/projections.ts";
import { checkUserSelection } from "../../src/compaction/verified/policy.ts";
import { userSelection } from "../../src/compaction/verified/generated/policy.js";

const user = (text: string, handle: string): ClaudeMessage => ({ role: "user", text, handle, toolUses: [] });
const assistant = (handle: string): ClaudeMessage => ({ role: "assistant", text: "Noted.", handle, toolUses: [] });

const summarized = (messages: ClaudeMessage[]): string => {
  const result = compact(messages, { keepRecentTokens: 1 });
  if (!("messages" in result)) throw new Error(JSON.stringify(result));
  return result.messages[0]!.text;
};

test("the opening fact survives 98 equally sized distinct earlier messages", () => {
  const messages: ClaudeMessage[] = [];
  const fact = "Discussion only.\n\nRemember the orchard forever.";
  for (let i = 0; i < 98; i++) {
    const body = (i === 0 ? fact : `Background ${i}.`).padEnd(240, "x");
    messages.push(user(body, `u-${i}`), assistant(`a-${i}`));
  }
  messages.push(user("Recent one.", "recent-1"), user("Recent two.", "recent-2"), user("Recent three.", "recent-3"), user("Final tail.", "tail"));
  const summary = summarized(messages);
  const earlier = summary.split("[Earlier user messages]")[1]?.split("[Recent user directions and discussion]")[0] ?? "";
  expect(earlier).toContain(fact);
  expect(earlier).toContain("later directives may be omitted");
});

test("the opening fact wins over a shorter Ok even under byte pressure", () => {
  const fact = "Discussion only.\n\nRemember the orchard forever.";
  const messages: ClaudeMessage[] = [user(fact, "u-0"), assistant("a-0"), user("Ok.", "u-1"), assistant("a-1")];
  for (let i = 2; i < 98; i++) messages.push(user(`Long ${i}: ${"x".repeat(6000)}`, `u-${i}`), assistant(`a-${i}`));
  messages.push(user("Recent one.", "recent-1"), user("Recent two.", "recent-2"), user("Recent three.", "recent-3"), user("Final tail.", "tail"));
  const earlier = summarized(messages).split("[Earlier user messages]")[1]?.split("[Recent user directions and discussion]")[0] ?? "";
  expect(earlier).toContain(fact);
  expect(earlier).not.toContain("User [entry u-1]:\nOk.");
});

test("the opening reserve can omit the immediately following correction even when the long appendix clips", () => {
  const messages: ClaudeMessage[] = [];
  for (let i = 0; i < 65; i++) {
    const body = i === 0 ? "Use copper." : i === 1 ? `Correction: use silver. ${"More context. ".repeat(12)}`
      : i === 64 ? `Appendix: ${"x".repeat(60_000)}` : `Background ${i}.`;
    messages.push(user(body, `u-${i}`), assistant(`a-${i}`));
  }
  messages.push(user("Recent one.", "recent-1"), user("Recent two.", "recent-2"), user("Recent three.", "recent-3"), user("Final tail.", "tail"));
  const earlier = summarized(messages).split("[Earlier user messages]")[1]?.split("[Recent user directions and discussion]")[0] ?? "";
  expect(earlier).toContain("Use copper.");
  expect(earlier).not.toContain("Correction: use silver.");
  expect(earlier).toContain("omitted 1 user messages; source entries u-1 → u-1");
  expect(earlier).toContain("[omitted ");
});

test("generated occurrence lists obey opening reserve, recency closure, exact identity accounting and chronological rendering", () => {
  let seed = 0x17c0ffee;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const lengths = [0, 1, 2, 63, 64, 65, 66, 80, 100, 130];
  for (let trial = 0; trial < 180; trial++) {
    const count = trial < lengths.length ? lengths[trial]! : random() % 131;
    const texts = Array.from({ length: count }, (_, i) => `value-${random() % (trial % 3 === 0 ? 5 : 90)}-界`);
    const entries = [...texts, "recent-a", "recent-b", "recent-c"].map((text, i) => ({
      kind: "user" as const, text, index: i, entryId: i < count ? `u-${i}` : `recent-${i}`, sourceEntryId: `source-${i}`,
    }));
    const result = projectWithMetadata(entries as CompactionEvent[]);
    const actual = result.sections.goal.flatMap((line) => {
      const match = /^User \[entry u-(\d+)\]:/.exec(line);
      return match ? [Number(match[1])] : [];
    });
    const last = new Map(texts.map((text, i) => [text, i]));
    const ranked = texts.map((text, i) => ({ i, distinct: last.get(text) === i }))
      .filter(({ i }) => i !== 0).sort((a, b) => Number(b.distinct) - Number(a.distinct) || b.i - a.i);
    const expected = count <= 64 ? texts.map((_, i) => i)
      : [0, ...ranked.slice(0, 63).map(({ i }) => i)].sort((a, b) => a - b);
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
    expect(actual.length).toBeLessThanOrEqual(64);
    const selected = new Set(actual);
    const omitted = texts.map((_, i) => i).filter((i) => !selected.has(i));
    expect(result.omittedCounts.goal).toBe(omitted.length);
    expect(selected.size + omitted.length).toBe(count);
    expect(result.userSelection.gate.noticeRequired).toBe(omitted.length > 0);
    const omittedDistinct = omitted.filter((i) => last.get(texts[i]!) === i);
    if (count > 64) {
      expect(actual.filter((i) => omittedDistinct.some((j) => j > i))).toEqual(
        omittedDistinct.some((j) => j > 0) ? [0] : [],
      );
      if (omittedDistinct.length) expect(actual.filter((i) => i !== 0 && last.get(texts[i]!) !== i)).toEqual([]);
    }
    for (const i of actual.filter((i) => i !== 0 && last.get(texts[i]!) === i)) {
      expect(omitted.some((j) => j > i && last.get(texts[j]!) === j)).toBe(false);
    }
  }
});

test("the compact caller uses the gate, and a dropped occurrence cannot commit", () => {
  const messages: ClaudeMessage[] = [];
  for (let i = 0; i < 70; i++) messages.push(user(`User ${i}`, `u-${i}`), assistant(`a-${i}`));
  messages.push(user("Final tail.", "tail"));
  expect(summarized(messages)).toContain("later directives may be omitted");
  const original = userSelection.step;
  try {
    userSelection.step = () => { throw new Error("selection gate reached"); };
    expect(() => summarized(messages)).toThrow("selection gate reached");
    let dropped = false;
    userSelection.step = (params, state, input) => {
      if (!dropped && (input as { op: number }).op === 0) { dropped = true; return state; }
      return original(params, state, input);
    };
    expect(() => summarized(messages)).toThrow("user selection failed its verified check");
    expect(dropped).toBe(true);
  } finally {
    userSelection.step = original;
  }
});

test("the committed gate rejects a missing final notice, including a quoted notice elsewhere", () => {
  const texts = Array.from({ length: 65 }, (_, i) => `User ${i}`);
  const gate = checkUserSelection(texts, new Set([0, ...Array.from({ length: 63 }, (_, i) => i + 2)]));
  const header = "[Earlier user messages]";
  const marker = "… omitted 1 user messages; source entries u-1 → u-1";
  const goalBlock = `${header}\n${marker}\n\nUser [entry u-0]:\nUser 0`;
  expect(gate.noticeRequired).toBe(true);
  expect(gate.acceptSummary(`before\n\n${goalBlock}\n`, goalBlock, 8, marker, header)).toBe(true);
  expect(gate.acceptSummary(`before\n\n${header}\n\nUser [entry u-0]:\nUser 0\n`, goalBlock, 8, marker, header)).toBe(false);
  const noNotice = `${header}\n\nUser [entry u-0]:\n${marker}`;
  expect(gate.acceptSummary(noNotice, noNotice, 0, marker, header)).toBe(false);
  expect(gate.acceptSummary(`${goalBlock}\n\n${noNotice}`, goalBlock, goalBlock.length + 2, marker, header)).toBe(false);
});

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
  expect(earlier).toContain("Old choice: copper.");
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
  expect(earlier).toContain("Use copper.");
  expect(earlier).toMatch(/… omitted \d+ user messages; source entries [^\n]+/);
});
