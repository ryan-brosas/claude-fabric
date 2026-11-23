import { describe, expect, test } from "bun:test";
import { parseCsv } from "../src/csv/parse";

describe("parseCsv", () => {
  test("splits plain rows", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("keeps delimiters inside quotes", () => {
    expect(parseCsv('a,"x,y"')).toEqual([["a", "x,y"]]);
  });

  test("unescapes doubled quotes", () => {
    expect(parseCsv('a,"he said ""hi"""')).toEqual([["a", 'he said "hi"']]);
  });

  test("keeps newlines inside quotes", () => {
    expect(parseCsv('a,"line1\nline2"')).toEqual([["a", "line1\nline2"]]);
  });

  test("accepts CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("reports an unterminated quote", () => {
    expect(() => parseCsv('a,"oops')).toThrow();
  });
});
