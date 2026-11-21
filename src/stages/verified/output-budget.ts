// The gate every result passes. The rule and its laws live in
// proofs/output-budget.ts; this folds the lengths the stage really produced into
// the compiled machine, so a result longer than the cap, a text that was cut when
// it fit, or a saved line that lost its file cannot reach the model.
import { resultBudget } from "./generated/output-budget.js";

/** What the stage knows once it has built a result. */
export interface BudgetFacts {
  /** The formatted result, before any cut. */
  text: number;
  /** The cap the model sees; at least one, or no proof covers the call. */
  max: number;
  /** The hint and saved line on the saved path; 0 when the file was not saved. */
  suffix: number;
  /** The full hint length, even if the fallback leaves no room for it. */
  hint: number;
  /** The length of the kernel's own cut at the full cap; 0 when it did not run. */
  fallback: number;
  /** The whole text reached a file. */
  wrote: boolean;
}

/** The lengths the machine proves for those facts. */
export interface BudgetLengths {
  /** The middle-cut body beside the suffix. */
  body: number;
  /** The room that body may use. */
  bodyBudget: number;
  /** The middle cut at the body budget. */
  cut: number;
  /** The saved path's result after the cap takes its last word. */
  kept: number;
  /** The hint length the machine chose for the fallback path. */
  fallbackSuffix: number;
  /** The result's length. */
  out: number;
}

const bit = (value: boolean): number => (value ? 1 : 0);

export const budgetLengths = (facts: BudgetFacts): BudgetLengths => {
  const state = resultBudget.step({}, resultBudget.init({}), {
    text: facts.text,
    max: facts.max,
    suffix: facts.suffix,
    hint: facts.hint,
    fallback: facts.fallback,
    wrote: bit(facts.wrote),
  });
  const scalars = state.scalars;
  return {
    body: scalars["out.body"],
    bodyBudget: scalars["out.bodyBudget"],
    cut: scalars["out.cut"],
    kept: scalars["out.kept"],
    fallbackSuffix: scalars["out.fallbackSuffix"],
    out: scalars["out.out"],
  };
};

/** Whether the result the stage built is the length the machine proves for its facts. */
export const acceptBudget = (facts: BudgetFacts, produced: number): boolean =>
  budgetLengths(facts).out === produced;
