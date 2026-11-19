// What compact.ts answers when no cut of its own applies: no prompt to start a tail on, or nothing
// older than the tail but an earlier summary. The rule reads two numbers, the transcript's
// estimated tokens and the tail budget:
//
// - a transcript within the budget is skipped: there is nothing to compact;
// - one over the budget goes to core's compactor, which can cut inside a turn, because a skip
//   would leave a full context as it is;
// - exactly one of the two answers holds.
//
// compact.ts folds the two numbers into the compiled machine in
// src/compaction/verified/no-cut.ts and answers through its verdict.
import { fun, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type NoCutBug =
  | "an over-budget transcript is skipped"
  | "a transcript within budget goes to core"
  | "a transcript at the budget goes to core"
  | "both answers hold";

const noCut = (bug?: NoCutBug) => fun("compaction without a cut")
  .inputs({ total: nat, budget: nat })
  .returns(({ total, budget }) => {
    const over = bug === "a transcript at the budget goes to core" ? total.atLeast(budget) : total.gt(budget);
    const core = bug === "an over-budget transcript is skipped" ? 0
      : bug === "a transcript within budget goes to core" ? 1
      : when(over, 1, 0);
    return { core, skip: bug === "both answers hold" ? 1 : when(over, 0, 1) };
  });

export const noCutKernels = (bug?: NoCutBug): Kernel[] => {
  const n = noCut(bug);
  // Stated over the inputs, so a rule that always skips, or always defers, is refused.
  return [{
    id: "noCut",
    fun: n,
    decisions: [
      n.law("core_iff_over: a transcript goes to core exactly when it is over the budget", () => [],
        (o, e) => o.core.eq(when(e.total.gt(e.budget), 1, 0))),
      n.law("skip_iff_within: a transcript is skipped exactly when it fits the budget", () => [],
        (o, e) => o.skip.eq(when(e.total.atMost(e.budget), 1, 0))),
      n.law("one_answer: exactly one of core and skip holds", () => [],
        (o) => o.core.plus(o.skip).eq(1)),
    ],
  }];
};

export const NO_CUT_BUGS: NoCutBug[] = [
  "an over-budget transcript is skipped",
  "a transcript within budget goes to core",
  "a transcript at the budget goes to core",
  "both answers hold",
];
