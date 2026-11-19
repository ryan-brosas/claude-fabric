import { expect, test } from "bun:test";
import { check } from "../../src/kernel/check.ts";
import { TOOLS } from "../../src/providers/tools/index.ts";
import { guestTypes, inputFields } from "../../src/registry/generate.ts";
import { typeErrorGuidance } from "../../src/stages/type-guidance.ts";

const declarations = guestTypes(TOOLS);
// The hints read the tools from the one list, through the registry, exactly as the host does.
const tools = TOOLS.map((action) => ({ name: action.name, fields: inputFields(action) }));
const hint = (code: string): string[] => typeErrorGuidance(code, check(code, declarations).errors, tools);
const ALL_TOOLS = "\`Read\`, \`Write\`, \`Edit\`, \`Grep\`, \`Glob\`, \`Bash\`";

test("says nothing when the checks passed", () => {
  expect(typeErrorGuidance("return 1;", [], tools)).toEqual([]);
});

test("names the called tool's real fields for an unknown property", () => {
  const hints = hint('return await Bash({ command: "ls", settle: true });');
  expect(hints).toHaveLength(1);
  expect(hints[0]).toContain("\`settle\` is not a \`Bash\` field");
  expect(hints[0]).toContain("\`command\`, \`timeout\`, \`description\`, \`allowFailure\`");
  expect(hint('return await Read({ file_path: "a", context: 3 });')[0]).toContain("Read takes: \`file_path\`, \`offset\`, \`limit\`");
  expect(hint('return await Glob({ pattern: "a", head_limit: 2 });')[0]).toContain("Glob takes: \`pattern\`, \`path\`");
});

test("points a misplaced envelope argument outside the program", () => {
  const payloads = hint('return await Read({ file_path: "a", payloads: π.x });');
  expect(payloads[0]).toContain("\`payloads\` is a fabric_exec argument");
  expect(payloads[0]).toContain("π.<key>");
  expect(hint('return await Bash({ command: "ls", display: "probe" });')[0]).toContain("\`display\` is a fabric_exec argument");
  expect(hint("return payloads;")[0]).toContain("\`payloads\` is a fabric_exec argument");
});

test("names every program tool when a program reaches for a namespace", () => {
  const hints = hint('return await pi.read("/tmp/x");');
  expect(hints[0]).toContain(ALL_TOOLS);
  expect(hints[0]).toContain("There is no namespace object");
});

test("sends fs, require and process to the tools", () => {
  for (const code of ['const fs = require("fs"); return 1;', "return process.cwd();", 'return fs.readFileSync("/x");']) {
    const hints = hint(code);
    expect({ code, hint: hints.find((line) => line.includes("a program has no")) }).toEqual({
      code,
      hint: expect.stringContaining(ALL_TOOLS),
    });
  }
});

test("calls out Promise.all tuple arity", () => {
  const hints = hint('const [a, b, c] = await Promise.all([Read("a"), Read("b")]); return c;');
  expect(hints[0]).toContain("one binding per promise");
});

test("stays silent for a semantic error and for a name no hint owns", () => {
  expect(hint('const n: number = "x"; return n;')).toEqual([]);
  expect(hint("return missingValue;")).toEqual([]);
  // An unknown property on a type that is not a program tool's input has no hint to give.
  expect(hint('const x = { nope: 1 } as { ok: number }; return x;')).toEqual([]);
});

test("keeps one hint per kind, however many errors name it", () => {
  const hints = hint('return await Bash({ command: "a", settle: true }) + await Bash({ command: "b", settle: true });');
  expect(hints).toHaveLength(1);
});
