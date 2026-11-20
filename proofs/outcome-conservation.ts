// The rebuild compares each effective current outcome with the same outcome in the rebuilt
// input. The strings and conflict checks stay outside the kernel; it decides whether the
// available multiplicity is enough for one matching outcome.
import { fun, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

type OutcomeBug = "accept a shortage" | "reject an exact match";

const conservation = (bug?: OutcomeBug) => fun("outcome conservation")
  .inputs({ required: nat, available: nat })
  .returns(({ required, available }) => ({
    accepted: when(bug === "accept a shortage" ? available.plus(1).atLeast(required)
      : bug === "reject an exact match" ? available.gt(required)
      : available.atLeast(required), 1, 0),
  }));

export const outcomeConservationKernels = (bug?: OutcomeBug): Kernel[] => {
  const rule = conservation(bug);
  return [{
    id: "outcomeConservation",
    fun: rule,
    decisions: [
      rule.law("enough_iff_available: an outcome is accepted exactly when its rebuilt multiplicity covers the current multiplicity", () => [],
        (out, input) => out.accepted.eq(when(input.available.atLeast(input.required), 1, 0))),
    ],
  }];
};

export const OUTCOME_CONSERVATION_BUGS: OutcomeBug[] = ["accept a shortage", "reject an exact match"];
