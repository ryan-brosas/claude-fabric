// The cut compact.ts makes: summarize the oldest messages, then keep a suffix
// that fits the tail budget and starts only at a user prompt. The producer picks
// the cut in plain TypeScript; every cut must pass the compiled machine in
// src/compaction/verified/cut.ts, which folds one step per message and one commit.
import { all, bool, nat, oneOf, rule, when, yes } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type CutBug =
  | "a kept tail may start mid-exchange"
  | "a kept tail may exceed the budget"
  | "a kept tail may be interrupted"
  | "the summary may be empty";

/** Phases: 0 unstarted, 1 open, 2 refused. */
export const CUT_START = 0, CUT_OPEN = 1, CUT_REFUSED = 2;

/** Ops, in order: 0 message, 1 commit. */
export const cut = (bug?: CutBug) => rule("compaction cut")
  .params({ budget: nat })
  .inputs({ op: oneOf("message", "commit"), tail: bool, prompt: bool, bytes: nat })
  .state({ phase: CUT_START, tailCount: 0, tailPrompts: 0, tailBytes: 0, summarized: 0 })
  .flags(({ tail, prompt, bytes, budget, phase, tailCount, tailPrompts, tailBytes, summarized }) => ({
    open: phase.eq(CUT_START),
    startsAtPrompt: bug === "a kept tail may start mid-exchange" ? yes
      : tail.not().or(tailCount.gt(0)).or(prompt),
    withinBudget: bug === "a kept tail may exceed the budget" ? yes
      : tail.not().or(tailBytes.plus(bytes).atMost(budget)).or(tailPrompts.plus(when(prompt, 1, 0)).atMost(1)),
    // The kept messages are one suffix: once a message is kept, every later
    // one is kept too.
    suffixKept: bug === "a kept tail may be interrupted" ? yes : tailCount.eq(0).or(tail),
    complete: bug === "the summary may be empty" ? yes
      : all(summarized.gt(0), tailCount.gt(0), tailPrompts.gt(0),
        tailBytes.atMost(budget).or(tailPrompts.atMost(1))),
  }))
  .step(({ op, open, startsAtPrompt, withinBudget, suffixKept, complete, tail, prompt, bytes, tailCount, tailPrompts, tailBytes, summarized }) => ({
    phase: op.match({
      message: () => when(open.and(startsAtPrompt).and(withinBudget).and(suffixKept), CUT_START, CUT_REFUSED),
      commit: () => when(open.and(complete), CUT_OPEN, CUT_REFUSED),
    }),
    tailCount: when(op.is("message").and(tail), tailCount.plus(1), tailCount),
    tailPrompts: when(op.is("message").and(tail).and(prompt), tailPrompts.plus(1), tailPrompts),
    tailBytes: when(op.is("message").and(tail), tailBytes.plus(bytes), tailBytes),
    summarized: when(op.is("message").and(tail.not()), summarized.plus(1), summarized),
  }));

export const cutKernels = (bug?: CutBug): Kernel[] => {
  const r = cut(bug);
  return [{
    id: "compactionCut",
    rule: r,
    laws: [
      r.law("cut_sound: an open cut summarizes at least one message, keeps a prompt-led tail, and keeps it within budget or as one exchange",
        ({ phase, summarized, tailCount, tailPrompts, tailBytes, budget }) => phase.eq(CUT_OPEN).implies(all(
          summarized.gt(0),
          tailCount.gt(0),
          tailPrompts.gt(0),
          tailBytes.atMost(budget).or(tailPrompts.atMost(1)),
        ))),
    ],
    stepLaws: [
      r.stepLaw("prompt_boundary: a kept tail opens on a prompt, never inside an exchange",
        (e, after) => all(e.phase.eq(CUT_START), e.tail, e.tailCount.eq(0), e.prompt.not()).implies(after.phase.eq(CUT_REFUSED)),
        ({ op }) => op.is("message")),
      r.stepLaw("budget_or_one_exchange: a tail with two prompts never passes its budget",
        (e, after) => all(e.phase.eq(CUT_START), e.tail, e.tailBytes.plus(e.bytes).gt(e.budget), e.tailPrompts.plus(when(e.prompt, 1, 0)).gt(1)).implies(after.phase.eq(CUT_REFUSED)),
        ({ op }) => op.is("message")),
      r.stepLaw("suffix_kept: once a message is kept, no later one is summarized",
        (e, after) => all(e.phase.eq(CUT_START), e.tailCount.gt(0), e.tail.not()).implies(after.phase.eq(CUT_REFUSED)),
        ({ op }) => op.is("message")),
      r.stepLaw("refusal_final: a refused cut stays refused",
        ({ phase }, after) => phase.eq(CUT_REFUSED).implies(after.phase.eq(CUT_REFUSED))),
      r.stepLaw("messages_never_open: only a commit opens a cut",
        ({ op }, after) => op.is("message").implies(after.phase.ne(CUT_OPEN))),
      r.stepLaw("commit_needs_start: a commit opens only a fresh, unterminated cut",
        (e, after) => e.op.is("commit").and(after.phase.eq(CUT_OPEN)).implies(e.phase.eq(CUT_START))),
      r.stepLaw("commit_needs_summary: an open cut summarizes at least one message",
        (e, after) => e.op.is("commit").and(after.phase.eq(CUT_OPEN)).implies(e.summarized.gt(0))),
      r.stepLaw("counts_monotone: kept and summarized counters never shrink",
        ({ tailCount, tailPrompts, tailBytes, summarized }, after) => all(
          after.tailCount.atLeast(tailCount),
          after.tailPrompts.atLeast(tailPrompts),
          after.tailBytes.atLeast(tailBytes),
          after.summarized.atLeast(summarized))),
    ],
  }];
};

export const CUT_BUGS: CutBug[] = [
  "a kept tail may start mid-exchange",
  "a kept tail may exceed the budget",
  "a kept tail may be interrupted",
  "the summary may be empty",
];
