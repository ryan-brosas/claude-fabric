// The rebuild compares each effective current outcome with the same outcome in the rebuilt
// input. The strings and conflict checks stay outside the kernel; it decides whether the
// available multiplicity is enough for one matching outcome.
import { bool, fun, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

type OutcomeBug = "accept a shortage" | "reject an exact match" | "missing entry" | "wrong id"
  | "wrong bytes" | "altered stub" | "accept text difference" | "ignore original mismatch" | "reject verified stub";

const conservation = (bug?: OutcomeBug) => fun("outcome conservation")
  .inputs({ required: nat, available: nat, entryFound: bool, sameId: bool, bytesEqual: bool, stubEqual: bool,
    sameText: bool, verifiedLeft: bool, verifiedRight: bool, originalsEqual: bool })
  .returns(({ required, available, entryFound, sameId, bytesEqual, stubEqual, sameText, verifiedLeft, verifiedRight, originalsEqual }) => {
    let verified = bug === "missing entry" ? sameId : entryFound.and(sameId);
    if (bug === "wrong id") verified = entryFound;
    if (bug !== "wrong bytes") verified = verified.and(bytesEqual);
    if (bug !== "altered stub") verified = verified.and(stubEqual);
    const hasStub = verifiedLeft.or(verifiedRight);
    const same = bug === "accept text difference" ? sameText.or(originalsEqual)
      : bug === "ignore original mismatch" ? sameText.or(hasStub)
      : bug === "reject verified stub" ? sameText : sameText.or(hasStub.and(originalsEqual));
    return {
      accepted: when(bug === "accept a shortage" ? available.plus(1).atLeast(required)
        : bug === "reject an exact match" ? available.gt(required) : available.atLeast(required), 1, 0),
      verified: when(verified, 1, 0),
      same: when(same, 1, 0),
    };
  });

export const outcomeConservationKernels = (bug?: OutcomeBug): Kernel[] => {
  const rule = conservation(bug);
  return [{
    id: "outcomeConservation",
    fun: rule,
    decisions: [
      rule.law("enough_iff_available: an outcome is accepted exactly when its rebuilt multiplicity covers the current multiplicity", () => [],
        (out, input) => out.accepted.eq(when(input.available.atLeast(input.required), 1, 0))),
      rule.law("verified_entry: resolving a stub requires the named transcript entry", () => [],
        (o, e) => o.verified.eq(1).implies(e.entryFound)),
      rule.law("verified_id: resolving a stub requires the same tool use id", () => [],
        (o, e) => o.verified.eq(1).implies(e.sameId)),
      rule.law("verified_bytes: resolving a stub requires matching UTF-8 bytes", () => [],
        (o, e) => o.verified.eq(1).implies(e.bytesEqual)),
      rule.law("verified_text: resolving a stub requires the exact rebuilt stub", () => [],
        (o, e) => o.verified.eq(1).implies(e.stubEqual)),
      rule.law("verified_iff_facts: all four facts resolve the stub", () => [],
        (o, e) => o.verified.eq(when(e.entryFound.and(e.sameId).and(e.bytesEqual).and(e.stubEqual), 1, 0))),
      rule.law("same_iff_verified: texts match exactly, or a verified stub resolves to the same original", () => [],
        (o, e) => o.same.eq(when(e.sameText.or(e.verifiedLeft.or(e.verifiedRight).and(e.originalsEqual)), 1, 0))),
    ],
  }];
};

export const OUTCOME_CONSERVATION_BUGS: OutcomeBug[] = ["accept a shortage", "reject an exact match", "missing entry", "wrong id",
  "wrong bytes", "altered stub", "accept text difference", "ignore original mismatch", "reject verified stub"];
