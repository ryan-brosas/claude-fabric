import { expect, test } from "bun:test";
import { z } from "zod";
import { STORE } from "../../src/providers/store/index.ts";
import { TOOLS } from "../../src/providers/tools/index.ts";
import { HISTORY } from "../../src/providers/tools/history.ts";
import { defineAction } from "../../src/registry/action.ts";
import { defineBuiltin } from "../../src/registry/builtin.ts";
import { globalLines, guestTypes, namespaceLines, namespaceTypes, parseArgs, toolLines } from "../../src/registry/generate.ts";

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

const Flag = defineBuiltin({
  name: "flag",
  signature: "function flag<T = unknown>(key: string): T | undefined",
  call: "flag(key) -> value | undefined",
  doc: "Reads one flag.",
});

test("guestTypes declares exactly the program tools, the store globals, print and the timers", () => {
  const text = guestTypes(TOOLS, STORE);
  const declared = new Set([...text.matchAll(/declare function (\w+)/g)].map((m) => m[1]));
  expect([...declared].sort()).toEqual([...TOOLS.map((action) => action.name), ...STORE.map((builtin) => builtin.name), "print", "setTimeout", "clearTimeout"].sort());
});

test("history declarations, description and runtime checks come from the same actions", () => {
  const declarations = namespaceTypes("history", HISTORY);
  expect(declarations).toContain("recall(input: { query: string; limit?: number");
  expect(declarations).toContain("follow: { binding: { bytes: number; sha256: string }");
  expect(declarations).toContain("expand(input: { binding:");
  const lines = namespaceLines("history", HISTORY);
  expect(lines.map((line) => line.split("(")[0])).toEqual(["- history.recall", "- history.expand"]);
  expect(lines[0]).toContain("Wrap the whole query in double quotes for an exact phrase.");
  expect(() => parseArgs(HISTORY[0]!, [{ query: 42 }])).toThrow("query");
  expect(() => parseArgs(HISTORY[1]!, [{ binding: { bytes: 1, sha256: "bad" } }])).toThrow("binding.sha256");
});

test("guestTypes prints a builtin from its one definition, and nothing without it", () => {
  expect(guestTypes([Fixture], [Flag])).toContain("/** Reads one flag. */\ndeclare function flag<T = unknown>(key: string): T | undefined;");
  expect(guestTypes([Fixture])).not.toContain("declare function flag");
  expect(guestTypes(TOOLS, STORE)).toContain("/** " + STORE[0].doc + " */\ndeclare " + STORE[0].signature + ";");
});

test("globalLines gives the model one line per builtin", () => {
  expect(globalLines([Flag])).toEqual(["- flag(key) -> value | undefined. Reads one flag."]);
  expect(globalLines([])).toEqual([]);
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
    "/** A pending timer, only for clearTimeout. */",
    "interface TimerHandle { readonly __timer: never }",
    "/** Runs handler after timeout ms, within this call's time limit. */",
    "declare function setTimeout(handler: (_: void) => void, timeout?: number): TimerHandle;",
    "declare function clearTimeout(handle: TimerHandle): void;",
    "declare class URL {",
    "  constructor(url: string | URL, base?: string | URL);",
    "  hash: string; host: string; hostname: string; href: string; password: string; pathname: string; port: string; protocol: string; search: string; username: string;",
    "  readonly origin: string; readonly searchParams: URLSearchParams;",
    "  toString(): string; toJSON(): string;",
    "  static canParse(url: string | URL, base?: string | URL): boolean;",
    "  static parse(url: string | URL, base?: string | URL): URL | null;",
    "}",
    "declare class URLSearchParams implements Iterable<[string, string]> {",
    "  constructor(init?: string | Iterable<[string, string]> | Record<string, string>);",
    "  readonly size: number;",
    "  append(name: string, value: string): void;",
    "  delete(name: string, value?: string): void;",
    "  get(name: string): string | null; getAll(name: string): string[]; has(name: string, value?: string): boolean;",
    "  set(name: string, value: string): void; sort(): void; toString(): string;",
    "  forEach(callback: (value: string, key: string, parent: URLSearchParams) => void, thisArg?: unknown): void;",
    "  entries(): IterableIterator<[string, string]>; keys(): IterableIterator<string>; values(): IterableIterator<string>;",
    "  [Symbol.iterator](): IterableIterator<[string, string]>;",
    "}",
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
