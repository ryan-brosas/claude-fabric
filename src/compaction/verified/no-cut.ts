// What compact.ts answers when no cut of its own applies. The rule and its laws live in
// proofs/no-cut.ts; this folds the transcript's estimated tokens and the budget into the compiled
// machine, so an over-budget transcript is never skipped and one within budget never goes to core.
import { noCut } from "./generated/no-cut.js";

/** "core" when the transcript is over the budget, "skip" when it fits. */
export const noCutVerdict = (total: number, budget: number): "core" | "skip" => {
  const out = noCut.step({}, noCut.init({}), { total, budget }).scalars;
  if ((out["out.core"] ?? 0) + (out["out.skip"] ?? 0) !== 1) throw new Error("fabric: the no-cut verdict failed its verified check");
  return out["out.core"] === 1 ? "core" : "skip";
};
