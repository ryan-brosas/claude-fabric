// The wiring around the compiled time-limit rule; its laws are proved in proofs/call-timeout.ts.
import { expect, test } from "bun:test";
import { callTimeoutMs } from "../../src/kernel/verified/call-timeout.ts";

test("no timeout keeps 120000 ms, one within the limit is kept, one over it is capped", () => {
  expect(callTimeoutMs(undefined)).toBe(120_000);
  expect(callTimeoutMs(300)).toBe(300);
  expect(callTimeoutMs(600_000)).toBe(600_000);
  expect(callTimeoutMs(900_000)).toBe(600_000);
});
