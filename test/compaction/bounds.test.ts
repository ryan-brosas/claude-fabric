import { describe, expect, test } from "bun:test";
import { boundedExcerpt, boundedSuffix, earlierSummaryOmission, protectedBudgets, utf8Bytes } from "../../src/compaction/bounds.ts";

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

describe("boundedSuffix", () => {
  test("keeps a text whole when it fits", () => {
    expect(boundedSuffix("short text", 100)).toEqual({ text: "short text", omittedBytes: 0 });
  });

  test("keeps the newest bytes, states the loss at the start, and accounts for both", () => {
    const text = "OLDEST-" + "m".repeat(2000) + "-NEWEST";
    const cut = boundedSuffix(text, 256);
    const note = earlierSummaryOmission(cut.omittedBytes);
    expect(utf8Bytes(cut.text)).toBeLessThanOrEqual(256);
    expect(cut.text.startsWith(note)).toBe(true);
    expect(cut.text.endsWith("-NEWEST")).toBe(true);
    expect(cut.text).not.toContain("OLDEST-");
    expect(cut.omittedBytes + utf8Bytes(cut.text) - utf8Bytes(note)).toBe(utf8Bytes(text));
  });

  test("never splits a multi-byte character", () => {
    const text = "界🦊".repeat(1000);
    for (const maxBytes of [64, 65, 66, 67, 128, 129, 200, 1000]) {
      const cut = boundedSuffix(text, maxBytes);
      expect(utf8Bytes(cut.text)).toBeLessThanOrEqual(maxBytes);
      expect(cut.text).not.toContain("\uFFFD");
      // Whatever tail fits after the note is the last whole characters of the text.
      const body = cut.text.slice(earlierSummaryOmission(cut.omittedBytes).length);
      if (body) expect(body.endsWith("🦊")).toBe(true);
    }
  });

  test("returns nothing when the note alone does not fit", () => {
    expect(boundedSuffix("x".repeat(100), 0)).toEqual({ text: "", omittedBytes: 100 });
    expect(boundedSuffix("x".repeat(100), 8)).toEqual({ text: "", omittedBytes: 100 });
  });
});
