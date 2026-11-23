import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { checkProgram, run } from "../../src/kernel/host.ts";

type Kind = "accumulator" | "accumulator-process" | "process" | "url" | "syntax" | "live-cwd";
interface Fixture { kind: Kind; code: string; payloads?: Record<string, string> }

// Recorded benchmark inputs with machine-specific prefixes removed, then the two live-run examples.
// The live report supplied one program form for both runs, so those two fixtures match.
const fixtures: Fixture[] = JSON.parse(readFileSync(new URL("../fixtures/failed-programs.json", import.meta.url), "utf8"));
const PROJECT = "/fixture/project";

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

// Programs 4 and 5 still name process outside an exact cwd() call: the property test and the
// optional call cannot be silently rewritten. Program 1 has the original syntax error.
const passes = [false, true, true, false, false, true, true, true, true, true, true, true, true, true, true, true, true];

test("twelve of the fifteen benchmark programs now pass", () => {
  expect(fixtures.slice(0, 15).filter((fixture) => checkProgram(fixture.code, { cwd: PROJECT }).checked.ok)).toHaveLength(12);
});

for (const [index, fixture] of fixtures.entries()) {
  test(`recorded program ${index + 1}: ${fixture.kind}`, async () => {
    // This is the same path run() uses before it starts a worker. Never execute a passing fixture.
    const { program, checked } = checkProgram(fixture.code, { cwd: PROJECT });
    if (passes[index]) {
      expect(checked.ok).toBe(true);
      if (fixture.kind === "accumulator") expect(program).toContain(": Record<string, any>");
      if (fixture.kind === "process" || fixture.kind === "live-cwd") {
        expect(program).not.toContain("process.cwd()");
        expect(program).toContain('"/fixture/project"');
      }
      return;
    }
    expect(checked.ok).toBe(false);
    expect(program).toBe(fixture.code);
    // run() stops at the failed check; check the actual reply and the no-execution boundary.
    const reply = await run(fixture.code, tmpdir(), { payloads: fixture.payloads });
    expect(reply.ok).toBe(false);
    expect(reply.calls).toBe(0);
    expect(reply.ms.run).toBe(0);
    if (fixture.kind === "process" || fixture.kind === "accumulator-process") {
      expect(reply.text).toContain("Cannot find name 'process'");
      expect(reply.text).toContain("Recovery hint: a program has no `fs`, `require` or `process`.");
      expect(reply.text).toContain("Relative paths resolve against the project folder.");
    } else {
      expect(reply.text).toContain("expected.");
    }
  });
}
