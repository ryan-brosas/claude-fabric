// The counting rule repeat-guard.ts makes, proved here. The fingerprint string stays outside the
// kernel: the rule sees only whether this call repeats the last one. The stage picks the count in
// plain TypeScript, and every decision passes the compiled machine in
// src/stages/verified/repeat-guard.ts. A blocked call runs nothing: the host returns before it
// starts a worker on the machine's blocked bit (test/kernel/kernel.test.ts).
import { bool, fun, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type RepeatBug =
  | "the count does not climb"
  | "a different call keeps counting"
  | "warn fires before its threshold"
  | "block fires before its threshold";

/** The next count and the two verdict bits, from the count so far and whether this call repeats. */
const guard = (bug?: RepeatBug) => fun("repeat guard")
  .inputs({ count: nat, same: bool, warnAt: nat, blockAt: nat })
  .returns(({ count, same, warnAt, blockAt }) => {
    const next = bug === "the count does not climb" ? when(same, count, 1)
      : bug === "a different call keeps counting" ? count.plus(1)
      : when(same, count.plus(1), 1);
    return {
      count: next,
      warned: when(next.atLeast(bug === "warn fires before its threshold" ? warnAt.minus(1) : warnAt), 1, 0),
      blocked: when(next.atLeast(bug === "block fires before its threshold" ? warnAt : blockAt), 1, 0),
    };
  });

export const repeatGuardKernels = (bug?: RepeatBug): Kernel[] => {
  const g = guard(bug);
  return [{
    id: "repeatGuard",
    fun: g,
    decisions: [
      g.law("count_climbs: a call with the same fingerprint counts one higher than the last", () => [],
        (o, e) => e.same.implies(o.count.eq(e.count.plus(1)))),
      g.law("count_resets: a call with a different fingerprint starts the count again at one", () => [],
        (o, e) => e.same.not().implies(o.count.eq(1))),
      g.law("warn_exact: a call warns exactly when its count reaches the warn threshold", () => [],
        (o, e) => o.warned.eq(1).iff(o.count.atLeast(e.warnAt))),
      g.law("block_exact: a call is blocked exactly when its count reaches the block threshold", () => [],
        (o, e) => o.blocked.eq(1).iff(o.count.atLeast(e.blockAt))),
    ],
  }];
};

export const REPEAT_BUGS: RepeatBug[] = [
  "the count does not climb",
  "a different call keeps counting",
  "warn fires before its threshold",
  "block fires before its threshold",
];
