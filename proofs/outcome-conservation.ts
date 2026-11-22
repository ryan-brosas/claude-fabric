// The host supplies verification facts and compares outcome strings. This machine
// decides whether a stub resolves, equal strings match, and multiplicity is enough.
import { bool, fun, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

type OutcomeBug = "accept a shortage" | "reject an exact match" | "missing entry" | "wrong id"
  | "wrong bytes" | "wrong digest" | "altered stub" | "ineligible" | "accept text difference";

const conservation = (bug?: OutcomeBug) => fun("outcome conservation")
  .inputs({ required: nat, available: nat, entryFound: bool, sameId: bool, bytesEqual: bool,
    digestMatches: bool, stubEqual: bool, eligible: bool, sameText: bool })
  .returns(({ required, available, entryFound, sameId, bytesEqual, digestMatches, stubEqual, eligible, sameText }) => {
    let verified = bug === "missing entry" ? sameId : entryFound.and(sameId);
    if (bug === "wrong id") verified = entryFound;
    if (bug !== "wrong bytes") verified = verified.and(bytesEqual);
    if (bug !== "wrong digest") verified = verified.and(digestMatches);
    if (bug !== "altered stub") verified = verified.and(stubEqual);
    if (bug !== "ineligible") verified = verified.and(eligible);
    return {
      accepted: when(bug === "accept a shortage" ? available.plus(1).atLeast(required)
        : bug === "reject an exact match" ? available.gt(required) : available.atLeast(required), 1, 0),
      verified: when(verified, 1, 0),
      same: bug === "accept text difference" ? 1 : when(sameText, 1, 0),
    };
  });

export const outcomeConservationKernels = (bug?: OutcomeBug): Kernel[] => {
  const rule = conservation(bug);
  return [{ id: "outcomeConservation", fun: rule, decisions: [
    rule.law("enough_iff_available: an outcome is accepted exactly when its rebuilt multiplicity covers the current multiplicity", () => [],
      (o, e) => o.accepted.eq(when(e.available.atLeast(e.required), 1, 0))),
    rule.law("verified_entry: resolving a stub requires the named transcript entry", () => [],
      (o, e) => o.verified.eq(1).implies(e.entryFound)),
    rule.law("verified_id: resolving a stub requires the same tool use id", () => [],
      (o, e) => o.verified.eq(1).implies(e.sameId)),
    rule.law("verified_bytes: resolving a stub requires matching UTF-8 bytes", () => [],
      (o, e) => o.verified.eq(1).implies(e.bytesEqual)),
    rule.law("digest_matches: resolving a stub requires the original text digest", () => [],
      (o, e) => o.verified.eq(1).implies(e.digestMatches)),
    rule.law("verified_text: resolving a stub requires the exact rebuilt stub", () => [],
      (o, e) => o.verified.eq(1).implies(e.stubEqual)),
    rule.law("writer_eligible: resolving a stub requires writer eligibility", () => [],
      (o, e) => o.verified.eq(1).implies(e.eligible)),
    rule.law("verified_iff_facts: all verification facts resolve the stub", () => [],
      (o, e) => o.verified.eq(when(e.entryFound.and(e.sameId).and(e.bytesEqual).and(e.digestMatches).and(e.stubEqual).and(e.eligible), 1, 0))),
    rule.law("same_iff_equal: outcome texts match exactly", () => [],
      (o, e) => o.same.eq(when(e.sameText, 1, 0))),
  ] }];
};

export const OUTCOME_CONSERVATION_BUGS: OutcomeBug[] = ["accept a shortage", "reject an exact match", "missing entry", "wrong id",
  "wrong bytes", "wrong digest", "altered stub", "ineligible", "accept text difference"];
