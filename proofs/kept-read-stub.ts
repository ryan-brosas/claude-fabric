// The replacement decision. The host computes the byte lengths and the five
// independent facts from the proposed stub and the verified transcript rows.
import { bool, fun, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type KeptReadStubBug = "inclusive threshold" | "ignore original size" | "ignore stub cap" | "never replace"
  | "omit path" | "omit byte count" | "omit entry id" | "unrecoverable row" | "unverified call" | "never consider";

const keptReadStub = (bug?: KeptReadStubBug) => fun("kept Read replacement decision")
  .inputs({ original: nat, stub: nat, threshold: nat, cap: nat,
    namesPath: bool, namesBytes: bool, namesEntry: bool, recoverable: bool, verifiedCall: bool })
  .returns(({ original, stub, threshold, cap, namesPath, namesBytes, namesEntry, recoverable, verifiedCall }) => {
    const large = bug === "inclusive threshold" ? original.atLeast(threshold) : original.gt(threshold);
    const fitsOriginal = bug === "ignore original size" ? stub.atMost(cap) : stub.atMost(original);
    const fitsCap = bug === "ignore stub cap" ? stub.atMost(original) : stub.atMost(cap);
    const fits = large.and(fitsOriginal).and(fitsCap);
    let eligible = fits;
    if (bug !== "omit path") eligible = eligible.and(namesPath);
    if (bug !== "omit byte count") eligible = eligible.and(namesBytes);
    if (bug !== "omit entry id") eligible = eligible.and(namesEntry);
    if (bug !== "unrecoverable row") eligible = eligible.and(recoverable);
    if (bug !== "unverified call") eligible = eligible.and(verifiedCall);
    return { consider: bug === "never consider" ? 0 : when(fits, 1, 0),
      replace: bug === "never replace" ? 0 : when(eligible, 1, 0) };
  });

export const keptReadStubKernels = (bug?: KeptReadStubBug): Kernel[] => {
  const rule = keptReadStub(bug);
  return [{ id: "keptReadStub", fun: rule, decisions: [
    rule.law("size_considered: consider exactly a large result with a fitting stub", () => [],
      (o, e) => o.consider.eq(when(e.original.gt(e.threshold).and(e.stub.atMost(e.original)).and(e.stub.atMost(e.cap)), 1, 0))),
    rule.law("within_threshold_unchanged: a result at or below the threshold is unchanged", () => [],
      (o, e) => e.original.atMost(e.threshold).implies(o.replace.eq(0))),
    rule.law("replacement_not_larger: a replacement is not larger than the original", () => [],
      (o, e) => o.replace.eq(1).implies(e.stub.atMost(e.original))),
    rule.law("replacement_within_cap: a replacement does not exceed the stub cap", () => [],
      (o, e) => o.replace.eq(1).implies(e.stub.atMost(e.cap))),
    rule.law("names_path: a replacement names the file path", () => [],
      (o, e) => o.replace.eq(1).implies(e.namesPath)),
    rule.law("names_bytes: a replacement names the original byte count", () => [],
      (o, e) => o.replace.eq(1).implies(e.namesBytes)),
    rule.law("names_entry: a replacement names the transcript entry id", () => [],
      (o, e) => o.replace.eq(1).implies(e.namesEntry)),
    rule.law("recoverable_row: a replacement has a verified recoverable original row", () => [],
      (o, e) => o.replace.eq(1).implies(e.recoverable)),
    rule.law("verified_call: a replacement has a verified Read call", () => [],
      (o, e) => o.replace.eq(1).implies(e.verifiedCall)),
    rule.law("eligible_fit_replaced: a verified large result with a fitting, fully named stub is replaced", () => [],
      (o, e) => e.original.gt(e.threshold).and(e.stub.atMost(e.original)).and(e.stub.atMost(e.cap))
        .and(e.namesPath).and(e.namesBytes).and(e.namesEntry).and(e.recoverable).and(e.verifiedCall).implies(o.replace.eq(1))),
  ] }];
};

export const KEPT_READ_STUB_BUGS: KeptReadStubBug[] = ["inclusive threshold", "ignore original size", "ignore stub cap", "never replace",
  "omit path", "omit byte count", "omit entry id", "unrecoverable row", "unverified call", "never consider"];
