import { describe, expect, test } from "bun:test";
import { boundedExcerpt, boundedHeadTail, boundedTailExcerpt, earlierSummaryOmission, protectedBudgets, utf8Bytes } from "../../src/compaction/bounds.ts";

test("protected-block budgets keep short items whole and distribute the remaining bytes", () => {
  expect(protectedBudgets("hdr", ["a", "bcdef", "g".repeat(20)], 21)).toEqual([1, 5, 6]);
});

describe("boundedExcerpt", () => {
  test("names the source and accounts for retained UTF-8 text", () => {
    const text = "🦊界".repeat(100);
    const cut = boundedExcerpt(text, 80, "row-α");
    const marker = `\n[omitted ${cut.omittedBytes} UTF-8 bytes of row-α]`;
    expect(cut.text.endsWith(marker)).toBe(true);
    expect(utf8Bytes(cut.text.slice(0, -marker.length)) + cut.omittedBytes).toBe(utf8Bytes(text));
    expect(utf8Bytes(cut.text)).toBeLessThanOrEqual(80);
    expect(cut.text).not.toContain("\uFFFD");
  });

  test("reports all bytes omitted when the marker cannot fit", () => {
    expect(boundedExcerpt("x".repeat(100), 0, "source-id")).toEqual({ text: "", omittedBytes: 100 });
    expect(boundedExcerpt("x".repeat(100), 8, "source-id")).toEqual({ text: "", omittedBytes: 100 });
  });

  test("retains the source marker when only the marker fits", () => {
    const marker = "[omitted 100 UTF-8 bytes of source-id]";
    expect(boundedExcerpt("x".repeat(100), utf8Bytes(marker), "source-id"))
      .toEqual({ text: marker, omittedBytes: 100 });
  });
});

describe("boundedTailExcerpt", () => {
  test("keeps a Unicode suffix and accounts for every omitted byte", () => {
    const text = `${"界🦊".repeat(200)}\nFINAL_VALUE=40817`;
    for (let budget = 0; budget <= 300; budget++) {
      const cut = boundedTailExcerpt(text, budget, "reply-α");
      expect(utf8Bytes(cut.text)).toBeLessThanOrEqual(budget);
      expect(cut.text).not.toContain("\uFFFD");
      if (!cut.text) {
        expect(cut.omittedBytes).toBe(utf8Bytes(text));
        continue;
      }
      const marker = `[omitted ${cut.omittedBytes} UTF-8 bytes of reply-α]`;
      expect(cut.text.startsWith(marker)).toBe(true);
      const tail = cut.text.slice(marker.length).replace(/^\n/, "");
      expect(text.endsWith(tail)).toBe(true);
      expect(utf8Bytes(tail) + cut.omittedBytes).toBe(utf8Bytes(text));
      if (budget >= 100) expect(tail).toEndWith("FINAL_VALUE=40817");
    }
  });
});

describe("boundedHeadTail", () => {
  test("keeps a text whole when it fits", () => {
    expect(boundedHeadTail("short text", 100)).toEqual({ text: "short text", omittedBytes: 0 });
  });

  test("keeps the start and the end, states the loss in the middle, and accounts for it exactly", () => {
    const text = "OLDEST-" + "m".repeat(2000) + "-NEWEST";
    const cut = boundedHeadTail(text, 256);
    const note = earlierSummaryOmission(cut.omittedBytes);
    expect(utf8Bytes(cut.text)).toBeLessThanOrEqual(256);
    expect(cut.text.startsWith("OLDEST-")).toBe(true);
    expect(cut.text.endsWith("-NEWEST")).toBe(true);
    expect(cut.text).toContain(note);
    expect(note).toContain("from the middle of the earlier summary");
    expect(cut.omittedBytes + utf8Bytes(cut.text) - utf8Bytes(note)).toBe(utf8Bytes(text));
  });

  test("never splits a multi-byte character, and head and tail are a prefix and a suffix", () => {
    const text = "界🦊".repeat(1000);
    for (let maxBytes = 60; maxBytes <= 400; maxBytes++) {
      const cut = boundedHeadTail(text, maxBytes);
      expect(utf8Bytes(cut.text)).toBeLessThanOrEqual(maxBytes);
      expect(cut.text).not.toContain("\uFFFD");
      if (!cut.text) continue;
      const note = earlierSummaryOmission(cut.omittedBytes);
      const at = cut.text.indexOf(note);
      expect(at).toBeGreaterThanOrEqual(0);
      const head = cut.text.slice(0, at);
      const tail = cut.text.slice(at + note.length);
      expect(text.startsWith(head)).toBe(true);
      expect(text.endsWith(tail)).toBe(true);
      expect(cut.omittedBytes).toBe(utf8Bytes(text) - utf8Bytes(head) - utf8Bytes(tail));
    }
  });

  test("returns nothing when the note alone does not fit", () => {
    expect(boundedHeadTail("x".repeat(100), 0)).toEqual({ text: "", omittedBytes: 100 });
    expect(boundedHeadTail("x".repeat(100), 8)).toEqual({ text: "", omittedBytes: 100 });
  });
});
