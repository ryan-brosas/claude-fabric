// Admission for restoring result rows for one call. Matching, ordering and row
// identity are checked outside this numeric kernel.
import { fun, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

type RestorationBug = "over-restore" | "restore with existing outcome";

const restoration = (bug?: RestorationBug) => fun("outcome restoration")
  .inputs({ required: nat, existing: nat, restored: nat })
  .returns(({ required, existing, restored }) => ({
    admitted: when(
      (bug === "restore with existing outcome" ? required.gt(existing) : existing.eq(0).and(required.gt(existing)))
        .and(bug === "over-restore" ? restored.plus(existing).atLeast(required) : restored.plus(existing).eq(required)),
      1, 0),
  }));

export const outcomeRestorationKernels = (bug?: RestorationBug): Kernel[] => {
  const rule = restoration(bug);
  return [{
    id: "outcomeRestoration",
    fun: rule,
    decisions: [
      rule.law("exact_missing_only: admit exactly when there are no existing outcomes, a deficit exists, and the restored count equals that deficit", () => [],
        (out, input) => out.admitted.eq(when(input.existing.eq(0).and(input.required.gt(input.existing))
          .and(input.restored.plus(input.existing).eq(input.required)), 1, 0))),
    ],
  }];
};

export const OUTCOME_RESTORATION_BUGS: RestorationBug[] = ["over-restore", "restore with existing outcome"];
