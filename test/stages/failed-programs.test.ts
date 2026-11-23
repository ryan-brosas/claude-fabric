import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { check } from "../../src/kernel/check.ts";
import { checkProgram } from "../../src/kernel/host.ts";
import { TOOLS } from "../../src/providers/tools/index.ts";
import { guestTypes } from "../../src/registry/generate.ts";
import { repairCode } from "../../src/stages/code-repair.ts";

type Kind = "accumulator" | "accumulator-process" | "process" | "url" | "syntax" | "live-cwd";
interface Fixture { kind: Kind; code: string; payloads?: Record<string, string> }

// Recorded benchmark inputs with machine-specific prefixes removed, then the two live-run examples.
// The live report supplied one program form for both runs, so those two fixtures match.
const fixtures: Fixture[] = JSON.parse(readFileSync(new URL("../fixtures/failed-programs.json", import.meta.url), "utf8"));
const PROJECT = "/fixture/project";

type LiveKind = "await" | "print" | "optional-cwd" | "unrelated";
interface LiveFixture { kind: LiveKind; task: string; n: number; code: string; error: string }
const liveFixtures: LiveFixture[] = JSON.parse(readFileSync(new URL("../fixtures/await-failed-programs.json", import.meta.url), "utf8"));

test("replays all 13 live benchmark failures: eight pass and five retain their original errors", () => {
  const counts = Object.fromEntries(["await", "print", "optional-cwd", "unrelated"]
    .map((kind) => [kind, liveFixtures.filter((fixture) => fixture.kind === kind).length]));
  expect(counts).toEqual({ await: 4, print: 2, "optional-cwd": 3, unrelated: 4 });
  expect(liveFixtures.flatMap((fixture, index) => checkProgram(fixture.code, { cwd: PROJECT }).checked.ok ? [index + 1] : []))
    .toEqual([1, 4, 5, 7, 8, 10, 11, 13]);
});

for (const [index, fixture] of liveFixtures.entries()) {
  test(`live benchmark program ${index + 1}: ${fixture.task} #${fixture.n} (${fixture.kind})`, () => {
    // Replays are checks only: never execute any recorded program.
    const original = check(fixture.code, guestTypes(TOOLS));
    const { program, checked } = checkProgram(fixture.code, { cwd: PROJECT });
    expect(original.ok).toBe(false);
    if (fixture.kind === "await" || fixture.kind === "print" || index === 6 || index === 7) {
      expect(checked.ok).toBe(true);
      expect(program).not.toBe(fixture.code);
      return;
    }
    expect(checked.ok).toBe(false);
    expect(program).toBe(fixture.code);
    expect(checked.errors).toEqual(original.errors);
    const recorded = fixture.error.replace("Type errors; code was not executed:\n", "").split("\nRecovery hint:")[0];
    expect(checked.errors.join("\n")).toBe(recorded);
    if (fixture.kind === "optional-cwd") {
      const candidate = repairCode(fixture.code, original.indexTargets, original.cwdTargets, PROJECT);
      expect(candidate).not.toBe(fixture.code);
      const errors = check(candidate, guestTypes(TOOLS)).errors.join("\n");
      expect(index).toBe(11);
      // `undefined` is an identifier too: keep the conditional while repairing its cwd call.
      expect(candidate).toContain('"/fixture/project" ? undefined : undefined');
      expect(errors).toContain("Type 'undefined' is not assignable to type 'string'");
      expect(errors).toContain("This kind of expression is always truthy");
      expect(errors).not.toContain("Cannot find name 'process'");
    }
  });
}

test("the replay includes every recorded failure, including the overlapping case", () => {
  const counts = Object.fromEntries(["accumulator", "accumulator-process", "process", "url", "syntax", "live-cwd"]
    .map((kind) => [kind, fixtures.filter((fixture) => fixture.kind === kind).length]));
  expect(counts).toEqual({ accumulator: 9, "accumulator-process": 1, process: 3, url: 1, syntax: 1, "live-cwd": 2 });
});

test("the overlapping accumulator also passes once process is removed", () => {
  const fixture = fixtures.find((entry) => entry.kind === "accumulator-process");
  expect(fixture).toBeDefined();
  const code = fixture!.code.replace('process.cwd ? `${process.cwd()}/${f}` : f', "f");
  expect(code).not.toBe(fixture!.code);
  const result = checkProgram(code, { cwd: PROJECT });
  expect(result.checked.ok).toBe(true);
  expect(result.program).toContain(": Record<string, any>");
});

// Program 1 has a syntax error inside a template literal, which must stay unchanged.
const passes = [false, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];

test("fourteen of the fifteen benchmark programs now pass", () => {
  expect(fixtures.slice(0, 15).filter((fixture) => checkProgram(fixture.code, { cwd: PROJECT }).checked.ok)).toHaveLength(14);
});

for (const [index, fixture] of fixtures.entries()) {
  test(`recorded program ${index + 1}: ${fixture.kind}`, async () => {
    // This is the same path run() uses before it starts a worker. Never execute a passing fixture.
    const { program, checked } = checkProgram(fixture.code, { cwd: PROJECT });
    if (passes[index]) {
      expect(checked.ok).toBe(true);
      if (fixture.kind === "accumulator" || fixture.kind === "accumulator-process") expect(program).toContain(": Record<string, any>");
      if (fixture.kind === "process" || fixture.kind === "live-cwd") {
        expect(program).not.toContain("process.cwd()");
        expect(program).toContain('"/fixture/project"');
      }
      return;
    }
    expect(checked.ok).toBe(false);
    expect(program).toBe(fixture.code);
    const original = check(fixture.code, guestTypes(TOOLS));
    expect(checked.errors).toEqual(original.errors);
    expect(checked.errors).toEqual(["line 72:28 ',' expected."]);
  });
}
