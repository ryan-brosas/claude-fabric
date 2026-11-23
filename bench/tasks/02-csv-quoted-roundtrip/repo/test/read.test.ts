import { describe, expect, test } from "bun:test";
import { readObjects } from "../src/csv/header";
import { readCsv } from "../src/csv/read";
import { stringifyCsv } from "../src/csv/serialize";

describe("readCsv", () => {
  test("splits simple rows", () => {
    expect(readCsv("id,note\n1,hello\n")).toEqual([
      ["id", "note"],
      ["1", "hello"],
    ]);
  });

  test("trims unquoted cells by default", () => {
    expect(readCsv("a , b\n")).toEqual([["a", "b"]]);
  });

  test("keeps a delimiter inside quotes", () => {
    expect(readCsv('a,b\n"x, y",z\n')).toEqual([
      ["a", "b"],
      ["x, y", "z"],
    ]);
  });
});

describe("readObjects", () => {
  test("uses the first row as keys", () => {
    expect(readObjects("id,name\n1,Ada\n2,Grace\n")).toEqual([
      { id: "1", name: "Ada" },
      { id: "2", name: "Grace" },
    ]);
  });
});

describe("stringifyCsv", () => {
  test("writes plain rows", () => {
    expect(stringifyCsv([["a", "b"], ["1", "2"]])).toBe("a,b\n1,2");
  });
});
