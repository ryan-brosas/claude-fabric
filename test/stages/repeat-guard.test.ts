import { expect, test } from "bun:test";
import { BLOCK, INITIAL_STATE, RepeatGuard, WARN, blockText, fingerprint, next, warnText } from "../../src/stages/repeat-guard.ts";

test("counts consecutive identical programs and trips warn then block", () => {
  const guard = new RepeatGuard();
  for (let count = 1; count <= 7; count++) {
    expect(guard.observe("return 1")).toEqual({ state: { fingerprint: fingerprint("return 1"), count }, warn: count >= WARN, blocked: count >= BLOCK });
  }
});

test("next is pure: the same state and fingerprint give the same verdict", () => {
  const state = { fingerprint: "f", count: 2 };
  const before = { ...state };
  expect(next(state, "f")).toEqual({ state: { fingerprint: "f", count: 3 }, warn: true, blocked: false });
  expect(next(state, "f")).toEqual({ state: { fingerprint: "f", count: 3 }, warn: true, blocked: false });
  expect(state).toEqual(before);
  expect(next(INITIAL_STATE, "f").state.count).toBe(1);
});

test("resets on any differing program", () => {
  const guard = new RepeatGuard();
  for (let i = 0; i < 5; i++) guard.observe("return 1");
  expect(guard.observe("return 1").blocked).toBe(true);
  expect(guard.observe("return 2")).toEqual({ state: { fingerprint: fingerprint("return 2"), count: 1 }, warn: false, blocked: false });
});

test("does not count the same wrapper as a loop when the payloads differ", () => {
  const guard = new RepeatGuard();
  const wrapper = "const r = await Bash({ command: π.cmd, allowFailure: true }); return r.output;";
  for (let i = 1; i <= 12; i++) {
    expect(guard.observe(wrapper, { cmd: "echo step-" + i })).toMatchObject({ state: { count: 1 }, warn: false, blocked: false });
  }
});

test("still blocks identical programs with identical payloads", () => {
  const guard = new RepeatGuard();
  const wrapper = "const r = await Bash({ command: π.cmd }); return r.output;";
  let verdict = guard.observe(wrapper, { cmd: "echo noop" });
  for (let i = 1; i < BLOCK; i++) verdict = guard.observe(wrapper, { cmd: "echo noop" });
  expect(verdict).toMatchObject({ state: { count: BLOCK }, warn: true, blocked: true });
});

test("treats payload key order as cosmetic", () => {
  const guard = new RepeatGuard();
  const code = "return [π.a, π.b];";
  let verdict = guard.observe(code, { a: "1", b: "2" });
  for (let i = 2; i <= BLOCK; i++) verdict = guard.observe(code, i % 2 === 0 ? { a: "1", b: "2" } : { b: "2", a: "1" });
  expect(verdict.state.count).toBe(BLOCK);
  expect(verdict.blocked).toBe(true);
});

test("treats absent, undefined and empty payloads as the same call", () => {
  const guard = new RepeatGuard();
  guard.observe("return 1");
  guard.observe("return 1", undefined);
  expect(guard.observe("return 1", {}).state.count).toBe(3);
});

test("cannot be confused by payload boundaries that concatenate alike", () => {
  const guard = new RepeatGuard();
  guard.observe("return 1", { a: "bc" });
  expect(guard.observe("return 1", { ab: "c" }).state.count).toBe(1);
  guard.observe("return 1", { k: "x", l: "y" });
  expect(guard.observe("return 1", { k: "x\u0000l", l: "y" }).state.count).toBe(1);
});

test("resets the count when a payload value changes mid-run", () => {
  const guard = new RepeatGuard();
  for (let i = 0; i < 5; i++) guard.observe("return π.x", { x: "same" });
  expect(guard.observe("return π.x", { x: "other" })).toMatchObject({ state: { count: 1 }, warn: false, blocked: false });
});

test("warn and block texts name fabric_exec and the thresholds", () => {
  expect(warnText(3)).toContain("at 6 identical runs will be blocked");
  expect(warnText(3)).toContain("fabric_exec");
  expect(blockText(6)).toContain("executed 6 times in a row and was blocked");
  expect(blockText(6)).toContain("fabric_exec");
});

test("a guard with other thresholds honors them", () => {
  const guard = new RepeatGuard(2, 4);
  expect(guard.observe("return 1").warn).toBe(false);
  expect(guard.observe("return 1").warn).toBe(true);
  expect(guard.observe("return 1").blocked).toBe(false);
  expect(guard.observe("return 1").blocked).toBe(true);
});
