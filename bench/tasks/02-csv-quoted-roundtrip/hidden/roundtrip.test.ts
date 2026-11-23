import { describe, expect, test } from "bun:test";
import { readCsv } from "../../src/csv/read";
import { parseCsv } from "../../src/csv/parse";
import { stringifyCsv } from "../../src/csv/serialize";

describe("quoted cells keep their content", () => {
  test("spacing inside quotes survives the default trim", () => {
    expect(readCsv('id,note\n1,"  padded  "\n')).toEqual([
      ["id", "note"],
      ["1", "  padded  "],
    ]);
  });

  test("unquoted cells are still trimmed", () => {
    expect(readCsv(" a ,\tb \n")).toEqual([["a", "b"]]);
  });

  test("trim false keeps raw unquoted spacing", () => {
    expect(readCsv(" a , b \n", { trim: false })).toEqual([[" a ", " b "]]);
  });

  test("a value that is itself quoted is not unquoted twice", () => {
    expect(readCsv('v\n"""quoted"""\n')).toEqual([["v"], ['"quoted"']]);
  });

  test("escaped quotes, delimiters and newlines inside quotes", () => {
    expect(readCsv('a,b\n"he said ""hi""","x, y"\n')).toEqual([
      ["a", "b"],
      ['he said "hi"', "x, y"],
    ]);
    expect(readCsv('a\n"line1\nline2"\n')).toEqual([["a"], ["line1\nline2"]]);
  });
});

describe("stringifyCsv", () => {
  test("doubles quotes and quotes fields that need it", () => {
    expect(stringifyCsv([['say "hi"', "plain"]])).toBe('"say ""hi""",plain');
    expect(stringifyCsv([[" padded ", "a,b"]])).toBe('" padded ","a,b"');
    expect(stringifyCsv([["plain"]])).toBe("plain");
  });

  test("round-trips quoted, padded, empty and multiline cells", () => {
    const rows = [
      ["id", "note"],
      ["1", " padded "],
      ["2", 'say "hi"'],
      ["3", "a,b"],
      ["4", "line1\nline2"],
      ["5", ""],
    ];
    expect(readCsv(stringifyCsv(rows))).toEqual(rows);
  });

  test("parseCsv still reads what stringifyCsv writes", () => {
    const rows = [["a", 'x"y'], [" ", "\n"]];
    expect(parseCsv(stringifyCsv(rows))).toEqual(rows);
  });
});
