import { expect, test } from "bun:test";
import { z } from "zod";
import { TOOLS } from "../../src/providers/tools/index.ts";
import { defineAction } from "../../src/registry/action.ts";
import { guestTypes, parseArgs, toolLines } from "../../src/registry/generate.ts";

const Fixture = defineAction({
  name: "Fixture",
  doc: "One fixture.",
  input: z.object({
    pattern: z.string(),
    mode: z.enum(["a", "b"]).optional(),
    "-x": z.boolean().optional(),
  }),
  output: z.string(),
  positional: ["pattern"],
  run: async (i) => i.pattern,
});

const Pair = defineAction({
  name: "Pair",
  doc: "Two fields.",
  input: z.object({ file_path: z.string(), content: z.string() }),
  output: z.object({ output: z.string(), exitCode: z.number() }),
  positional: ["file_path", "content"],
  run: async (i) => ({ output: i.content, exitCode: 0 }),
});

test("guestTypes declares exactly the program tools, and print", () => {
  const text = guestTypes(TOOLS);
  const declared = new Set([...text.matchAll(/declare function (\w+)/g)].map((m) => m[1]));
  expect([...declared].sort()).toEqual([...TOOLS.map((action) => action.name), "print"].sort());
});

test("guestTypes prints the whole surface of a fixture", () => {
  const expected = [
    "// Globals a fabric_exec program sees. Names and fields follow Claude Code's own tools.",
    "",
    "interface FixtureInput {",
    "  pattern: string;",
    '  mode?: "a" | "b";',
    '  "-x"?: boolean;',
    "}",
    "",
    "/** One fixture. */",
    "declare function Fixture(input: string | FixtureInput): Promise<string>;",
    "",
    "interface PairInput {",
    "  file_path: string;",
    "  content: string;",
    "}",
    "",
    "interface PairResult {",
    "  output: string;",
    "  exitCode: number;",
    "}",
    "",
    "/** Two fields. */",
    "declare function Pair(input: PairInput): Promise<PairResult>;",
    "declare function Pair(file_path: string, content: string): Promise<PairResult>;",
    "",
    "/** Adds a line to the output. */",
    "declare function print(...values: unknown[]): void;",
    "/** String payloads passed in the same call's `payloads` argument. */",
    "declare const π: Readonly<Record<string, string>>;",
  ];
  expect(guestTypes([Fixture, Pair])).toBe(expected.join("\n") + "\n");
});

test("toolLines names every field, with ? on the optional ones", () => {
  expect(toolLines([Fixture])).toEqual(['- Fixture({pattern, mode?, "-x"?}) -> string. One fixture.']);
});

test("parseArgs takes one object argument as the input", () => {
  expect(parseArgs(Fixture, [{ pattern: "a", mode: "b", "-x": true }])).toEqual({ pattern: "a", mode: "b", "-x": true });
});

test("parseArgs maps a single string onto the main field", () => {
  expect(parseArgs(Fixture, ["a"])).toEqual({ pattern: "a" });
});

test("parseArgs maps several arguments onto the positional fields", () => {
  expect(parseArgs(Pair, ["p.txt", "text"])).toEqual({ file_path: "p.txt", content: "text" });
});

test("parseArgs ignores unknown keys", () => {
  expect(parseArgs(Fixture, [{ pattern: "a", extra: 1 }])).toEqual({ pattern: "a" });
});

test("parseArgs names the tool and the missing field", () => {
  expect(() => parseArgs(Fixture, [])).toThrow("Fixture: pattern is required (string)");
  expect(() => parseArgs(Pair, ["p.txt"])).toThrow("Pair: content is required (string)");
});

test("parseArgs does not call an optional field required", () => {
  expect(() => parseArgs(Fixture, [{ pattern: "a", mode: "" }])).toThrow("Fixture: mode ");
  expect(() => parseArgs(Fixture, [{ pattern: "a", mode: "" }])).not.toThrow("required");
});

test("parseArgs names the tool and the field with the wrong type", () => {
  expect(() => parseArgs(Fixture, [{ pattern: 3 }])).toThrow("Fixture: pattern expected string, received number");
});
