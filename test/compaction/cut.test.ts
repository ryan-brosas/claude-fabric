import { describe, expect, test } from "bun:test";
import { acceptCut, type CutMessage } from "../../src/compaction/verified/cut.ts";

const fact = (tail: boolean, prompt: boolean, bytes: number): CutMessage => ({ tail, prompt, bytes });

describe("the verified cut gate", () => {
  test("accepts a cut that summarizes at least one message and keeps a prompt-led tail within budget", () => {
    expect(acceptCut(10, [fact(false, true, 40), fact(true, true, 4), fact(true, false, 6)])).toBe(true);
  });

  test("refuses a tail that starts inside an exchange", () => {
    expect(acceptCut(100, [fact(false, true, 40), fact(true, false, 4)])).toBe(false);
  });

  test("refuses a kept message after a summarized one", () => {
    expect(acceptCut(10, [fact(true, true, 4), fact(false, true, 40)])).toBe(false);
  });

  test("refuses a summary with nothing summarized", () => {
    expect(acceptCut(100, [fact(true, true, 4)])).toBe(false);
  });

  test("refuses a tail with two prompts that passes its budget", () => {
    expect(acceptCut(5, [fact(false, true, 40), fact(true, true, 3), fact(true, true, 3)])).toBe(false);
  });

  test("accepts a single prompt-led exchange that alone exceeds the budget", () => {
    expect(acceptCut(2, [fact(false, true, 40), fact(true, true, 9), fact(true, false, 9)])).toBe(true);
  });

  test("refuses a budget that is not a natural or a fact with a bad size", () => {
    expect(acceptCut(-1, [fact(false, true, 1), fact(true, true, 1)])).toBe(false);
    expect(acceptCut(1.5, [fact(false, true, 1), fact(true, true, 1)])).toBe(false);
    expect(acceptCut(10, [fact(false, true, 1), fact(true, true, -2)])).toBe(false);
    expect(acceptCut(10, [])).toBe(false);
  });
});
