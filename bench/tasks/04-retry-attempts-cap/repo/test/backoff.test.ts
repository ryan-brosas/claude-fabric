import { describe, expect, test } from "bun:test";
import { computeDelay, totalDelay } from "../src/backoff";
import { normalizePolicy } from "../src/policy";

describe("computeDelay", () => {
  const policy = normalizePolicy({ baseDelayMs: 100, factor: 2, maxDelayMs: 250, jitter: 0 });

  test("grows exponentially between attempts", () => {
    expect(computeDelay(1, policy, () => 0)).toBe(100);
    expect(computeDelay(2, policy, () => 0)).toBe(200);
  });

  test("caps the exponential part", () => {
    expect(computeDelay(3, policy, () => 0)).toBe(250);
    expect(computeDelay(10, policy, () => 0)).toBe(250);
  });

  test("adds jitter below maxDelayMs", () => {
    const jittered = normalizePolicy({ baseDelayMs: 100, jitter: 0.5, maxDelayMs: 1_000 });
    expect(computeDelay(1, jittered, () => 1)).toBe(150);
  });

  test("totalDelay sums every wait before the last attempt", () => {
    expect(totalDelay(3, policy, () => 0)).toBe(300);
  });
});
