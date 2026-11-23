import { describe, expect, test } from "bun:test";
import { isExpired, remainingTtl } from "../src/ttl";
import { expiresAt } from "../src/ttl";

describe("ttl helpers", () => {
  test("expiresAt adds the ttl to the current time", () => {
    const before = Date.now();
    const value = expiresAt(before, 50);
    expect(value).toBeGreaterThanOrEqual(before + 50);
    expect(value).toBeLessThan(before + 1_000);
  });

  test("infinite ttl never expires", () => {
    expect(expiresAt(0, Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  test("remainingTtl is clamped at zero", () => {
    const entry = { key: "a", value: 1, createdAt: 1_000, expiresAt: 1_100 };
    expect(remainingTtl(entry, 1_025)).toBe(75);
    expect(remainingTtl(entry, 2_000)).toBe(0);
  });

  test("isExpired compares against the entry deadline", () => {
    const entry = { key: "a", value: 1, createdAt: 0, expiresAt: 100 };
    expect(isExpired(entry, 99)).toBe(false);
    expect(isExpired(entry, 101)).toBe(true);
  });
});
