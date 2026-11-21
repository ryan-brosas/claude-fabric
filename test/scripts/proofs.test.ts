import { describe, expect, test } from "bun:test";
import { compileJs } from "gdp-wired/machine";
import { policyKernels } from "../../proofs/policy.ts";
import { splitCompiled } from "../../scripts/proofs.ts";

const compiled = () => compileJs(policyKernels()[0]!.fun!.rule.machine);

describe("compiled kernel layout", () => {
  test("extracts the real 0.56 helper and removes only fork", () => {
    const result = splitCompiled(compiled(), "sample");
    expect(result.helpers.get("$wordDivisionValue")).toContain("function wordDivisionValue");
    expect(result.body).toContain("function init(params)");
    expect(result.body).toContain("function step(params, state, input)");
    expect(result.body).not.toContain("function fork(");
  });

  test("refuses unrecognized helpers, extra top-level code, and altered fork layouts", () => {
    const source = compiled();
    for (const changed of [
      source.replace("const $wordDivisionValue", "const $unknown"),
      source + "\nconst unexpected = 1;\n",
      source.replace("export function fork(state)", "export function fork(other)"),
      source.replace("export function init(params)", "export function* init(params)"),
      source.replace("function $n(", "function* $n("),
      source.replace("export function step(params, state, input)", "export function unknown(params, state, input)"),
    ]) {
      expect(() => splitCompiled(changed, "sample")).toThrow("Unrecognized compiled machine layout in sample");
    }
  });
});
