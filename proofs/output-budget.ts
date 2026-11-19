// The length arithmetic output-budget.ts makes, proved here. The string work stays in
// TypeScript: the rule sees only lengths, whether the whole text was saved, and the length of the
// kernel's own cut. cutMiddle's result is exactly min(text, cap) (its marker always fills the
// middle), so the machine models the middle cut as that minimum rather than a second copy of the
// string code. The stage builds the text and then asks the compiled machine in
// src/stages/verified/output-budget.ts whether the length it built is the proved one.
import { all, bool, fun, min, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type BudgetBug =
  | "the result may exceed the cap"
  | "a text that fits is still cut"
  | "the saved line may be cut"
  | "the fallback is cut even when it fits"
  | "a middle cut may exceed its cap";

/** The result length on every path: untouched, middle cut with the saved line, or the fallback. */
const budget = (bug?: BudgetBug) => fun("result budget")
  .inputs({ text: nat, max: nat, suffix: nat, fallback: nat, wrote: bool })
  // Math.max(1, max - suffix) is the room a saved-to line leaves; a cap of zero leaves nothing to
  // hold, so the rule covers every cap from one up.
  .assume(({ max }) => max.atLeast(1))
  .returns(({ text, max, suffix, fallback, wrote }) => {
    const bodyBudget = when(suffix.atLeast(max), 1, max.minus(suffix));
    const body = min(text, bug === "a middle cut may exceed its cap" ? bodyBudget.plus(1) : bodyBudget);
    // A middle cut keeps the whole line that names the saved file, unless the cap is too small
    // for the line itself; then its tail is the only part that can stay.
    const kept = bug === "the saved line may be cut" ? body
      : when(body.plus(suffix).gt(max), min(suffix, max), body.plus(suffix));
    const cut = min(text, bug === "a middle cut may exceed its cap" ? max.plus(1) : max);
    const out = bug === "the result may exceed the cap" ? when(text.atMost(max), text, when(wrote, body.plus(suffix), fallback))
      : bug === "a text that fits is still cut" ? when(text.atMost(max), body, when(wrote, kept, when(fallback.atMost(max), fallback, cut)))
      : bug === "the fallback is cut even when it fits" ? when(text.atMost(max), text, when(wrote, kept, cut))
      : when(text.atMost(max), text, when(wrote, kept, when(fallback.atMost(max), fallback, cut)));
    return { body, bodyBudget, cut, kept, out };
  });

export const outputBudgetKernels = (bug?: BudgetBug): Kernel[] => {
  const b = budget(bug);
  return [{
    id: "resultBudget",
    fun: b,
    decisions: [
      b.law("capped: the result is never longer than the cap", () => [],
        (o, e) => o.out.atMost(e.max)),
      b.law("untouched: a text at or under the cap comes back unchanged", () => [],
        (o, e) => e.text.atMost(e.max).implies(o.out.eq(e.text))),
      b.law("saved_line_kept: on the saved path the whole line that names the file survives", () => [],
        (o, e) => e.text.gt(e.max).and(e.wrote).implies(o.out.atLeast(min(e.suffix, e.max)))),
      b.law("fallback_kept: a fallback that fits the cap is returned whole", () => [],
        (o, e) => e.text.gt(e.max).and(e.wrote.not()).and(e.fallback.atMost(e.max)).implies(o.out.eq(e.fallback))),
      b.law("cuts_capped: a middle cut never exceeds the cap it was given", () => [],
        (o, e) => all(o.body.atMost(o.bodyBudget), o.cut.atMost(e.max))),
    ],
  }];
};

export const BUDGET_BUGS: BudgetBug[] = [
  "the result may exceed the cap",
  "a text that fits is still cut",
  "the saved line may be cut",
  "the fallback is cut even when it fits",
  "a middle cut may exceed its cap",
];
