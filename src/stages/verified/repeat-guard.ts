// The gate every repeat decision passes. The rule and its laws live in
// proofs/repeat-guard.ts; this folds one call's facts into the compiled machine,
// so a count that stops climbing, a changed call that keeps counting, or a warn or
// block that fires off its threshold cannot reach the host.
import { repeatGuard } from "./generated/repeat-guard.js";

/** What the machine decides for one call. */
export interface RepeatCount {
  /** Consecutive calls with this fingerprint, counting this one. */
  count: number;
  /** The count reaches the warn threshold. */
  warned: boolean;
  /** The count reaches the block threshold: the host runs nothing. */
  blocked: boolean;
}

const bit = (value: number): boolean => value === 1;

/** The next count and verdict bits, from the count so far and whether the call repeats. */
export const countRepeat = (count: number, same: boolean, warnAt: number, blockAt: number): RepeatCount => {
  const state = repeatGuard.step({}, repeatGuard.init({}), { count, same: same ? 1 : 0, warnAt, blockAt });
  const scalars = state.scalars;
  return { count: scalars["out.count"], warned: bit(scalars["out.warned"]), blocked: bit(scalars["out.blocked"]) };
};
