// Copied from pi-fabric (MIT, Tom X Nguyen) proofs/policy.ts at d331f629; kept only sampleWithin, the one decision the summary's sampling calls, with its laws intact.
import { all, fun, nat } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type PolicyBug = "sample loses an entry";

const sample = (bug?: PolicyBug) => fun("sample within")
  .inputs({ total: nat, retained: nat, omitted: nat, limit: nat })
  .returns(({ total, retained, omitted, limit }) => ({
    within: (bug === "sample loses an entry" ? total.atMost(retained.plus(omitted)) : total.eq(retained.plus(omitted))).and(retained.atMost(limit)),
  }));

export const policyKernels = (bug?: PolicyBug): Kernel[] => {
  const sa = sample(bug);
  return [
    { id: "sampleWithin", fun: sa, decisions: [
      sa.law("sample_accounting: retained plus omitted is the total, and the retained fit the limit", () => [], ({ within }, e) => within.implies(e.total.eq(e.retained.plus(e.omitted)).and(e.retained.atMost(e.limit)))),
      sa.law("sample_complete: exact accounting within the limit is accepted", () => [], ({ within }, e) => e.total.eq(e.retained.plus(e.omitted)).and(e.retained.atMost(e.limit)).implies(within)),
    ] },
  ];
};

export const POLICY_BUGS: PolicyBug[] = ["sample loses an entry"];
