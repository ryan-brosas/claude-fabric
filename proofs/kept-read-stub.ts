// The size decision for a proposed kept-Read replacement. The host supplies UTF-8
// byte lengths; eligibility and source-address verification are separate checks.
import { fun, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type KeptReadStubBug = "inclusive threshold" | "ignore original size" | "ignore stub cap" | "never replace";

const keptReadStub = (bug?: KeptReadStubBug) => fun("kept Read size decision")
  .inputs({ original: nat, stub: nat, threshold: nat, cap: nat })
  .returns(({ original, stub, threshold, cap }) => {
    const large = bug === "inclusive threshold" ? original.atLeast(threshold) : original.gt(threshold);
    const fitsOriginal = bug === "ignore original size" ? stub.atMost(cap) : stub.atMost(original);
    const fitsCap = bug === "ignore stub cap" ? stub.atMost(original) : stub.atMost(cap);
    return { replace: bug === "never replace" ? 0 : when(large.and(fitsOriginal).and(fitsCap), 1, 0) };
  });

export const keptReadStubKernels = (bug?: KeptReadStubBug): Kernel[] => {
  const rule = keptReadStub(bug);
  return [{ id: "keptReadStub", fun: rule, decisions: [
    rule.law("within_threshold_unchanged: a result at or below the threshold is unchanged", () => [],
      (o, e) => e.original.atMost(e.threshold).implies(o.replace.eq(0))),
    rule.law("replacement_not_larger: a replacement is not larger than the original", () => [],
      (o, e) => o.replace.eq(1).implies(e.stub.atMost(e.original))),
    rule.law("replacement_within_cap: a replacement does not exceed the stub cap", () => [],
      (o, e) => o.replace.eq(1).implies(e.stub.atMost(e.cap))),
    rule.law("eligible_fit_replaced: a large result with a fitting stub is replaced", () => [],
      (o, e) => e.original.gt(e.threshold).and(e.stub.atMost(e.original)).and(e.stub.atMost(e.cap)).implies(o.replace.eq(1))),
  ] }];
};

export const KEPT_READ_STUB_BUGS: KeptReadStubBug[] = ["inclusive threshold", "ignore original size", "ignore stub cap", "never replace"];
