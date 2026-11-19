// The stages decide through the compiled machines from proofs/. The laws are proved there; these
// cases check the wiring around them: the stage's decision is the machine's, and a call the machine
// cannot represent is refused here rather than shipped.
import { describe, expect, test } from "bun:test";
import { outputBudget, savedLine } from "../../src/stages/output-budget.ts";
import { BLOCK, INITIAL_STATE, WARN, fingerprint, next } from "../../src/stages/repeat-guard.ts";
import { acceptBudget, budgetLengths } from "../../src/stages/verified/output-budget.ts";
import { countRepeat } from "../../src/stages/verified/repeat-guard.ts";

const fallback = (text: string, max: number): string => text.slice(0, max) + "\n[result cut at " + max + " chars]";

describe("the verified repeat count", () => {
  test("counts one higher on the same fingerprint and starts again at one", () => {
    expect(countRepeat(2, true, WARN, BLOCK)).toEqual({ count: 3, warned: true, blocked: false });
    expect(countRepeat(5, false, WARN, BLOCK)).toEqual({ count: 1, warned: false, blocked: false });
  });

  test("warns and blocks exactly at their thresholds", () => {
    for (let count = 0; count < 9; count++) {
      const same = countRepeat(count, true, 3, 6);
      expect({ count: same.count, warned: same.warned, blocked: same.blocked })
        .toEqual({ count: count + 1, warned: count + 1 >= 3, blocked: count + 1 >= 6 });
    }
  });

  test("the stage's next is the machine's verdict, on both fingerprints", () => {
    for (const warnAt of [1, 2, 3]) {
      for (const blockAt of [warnAt, 6]) {
        for (let count = 0; count < 9; count++) {
          const counted = countRepeat(count, true, warnAt, blockAt);
          expect(next({ fingerprint: "f", count }, "f", warnAt, blockAt))
            .toEqual({ state: { fingerprint: "f", count: counted.count }, warn: counted.warned, blocked: counted.blocked });
        }
      }
    }
    expect(next(INITIAL_STATE, fingerprint("return 1"))).toEqual({
      state: { fingerprint: fingerprint("return 1"), count: 1 },
      warn: false,
      blocked: false,
    });
  });

  test("refuses a count or threshold the machine cannot represent", () => {
    expect(() => next({ fingerprint: "f", count: 1.5 }, "f")).toThrow(RangeError);
    expect(() => next({ fingerprint: "f", count: -1 }, "f")).toThrow(RangeError);
    expect(() => next(INITIAL_STATE, "f", 2.5)).toThrow(RangeError);
    expect(() => countRepeat(0, true, 3, Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });
});

describe("the verified result budget", () => {
  const saved = savedLine(4000, "/tmp/fabric-result-1/result.txt").length;

  test("takes the untouched, saved and fallback paths from the machine's arithmetic", () => {
    expect(budgetLengths({ text: 5, max: 10, suffix: 0, fallback: 0, wrote: false }).out).toBe(5);
    expect(budgetLengths({ text: 4000, max: 100, suffix: saved, fallback: 0, wrote: true }).out).toBe(100);
    expect(budgetLengths({ text: 4000, max: 100, suffix: 0, fallback: 50, wrote: false }).out).toBe(50);
    expect(budgetLengths({ text: 4000, max: 100, suffix: 0, fallback: 300, wrote: false }).out).toBe(100);
  });

  test("refuses a result the machine does not predict", () => {
    const facts = { text: 4000, max: 100, suffix: saved, fallback: 0, wrote: true };
    expect(acceptBudget(facts, budgetLengths(facts).out)).toBe(true);
    expect(acceptBudget(facts, budgetLengths(facts).out + 1)).toBe(false);
    expect(acceptBudget({ ...facts, text: 5 }, 4)).toBe(false);
  });

  test("refuses facts the machine cannot represent", () => {
    expect(() => budgetLengths({ text: 4000, max: 100, suffix: -1, fallback: 0, wrote: true })).toThrow(RangeError);
    expect(() => budgetLengths({ text: 4000, max: 0, suffix: 0, fallback: 0, wrote: false })).toThrow(RangeError);
  });

  test("every path the stage takes agrees with the machine, at every cap", async () => {
    for (const max of [5, 100, 1000]) {
      const short = await outputBudget({ text: "x".repeat(max), max, fallback, write: async () => "/tmp/fabric-result-1/result.txt" });
      expect(short).toBe("x".repeat(max));
      const path = "/tmp/fabric-result-1/result.txt";
      const savedPath = await outputBudget({ text: "x".repeat(max * 4), max, fallback, write: async () => path });
      const line = "[Full result (" + max * 4 + " chars) saved to: " + path + "]";
      expect(savedPath.length).toBeLessThanOrEqual(max);
      // The line naming the saved file survives whole whenever the cap holds it; below that only its
      // tail can stay, and the machine's lengths say which.
      if (max >= line.length) expect(savedPath).toEndWith(line);
      else expect(savedPath).toBe(line.slice(-max));
      const cut = await outputBudget({ text: "x".repeat(max * 4), max, fallback, write: async () => { throw new Error("disk full"); } });
      expect(cut.length).toBeLessThanOrEqual(max);
      // Below the marker's own length there is no room to say what was cut; the machine keeps the cap.
      if (max >= 100) expect(cut).toContain("chars cut from the middle");
    }
  });
});
