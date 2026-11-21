// Copied from pi-fabric (MIT, Tom X Nguyen) proofs/policy.ts at d331f629; sampleWithin retained.
// userPriority is the user-message selection decision for this port.
import { bool, fun, nat } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type PolicyBug = "sample loses an entry" | "older users win" | "duplicates crowd distinct users" | "short swap without pressure" | "long replacement";

const sample = (bug?: PolicyBug) => fun("sample within")
  .inputs({ total: nat, retained: nat, omitted: nat, limit: nat })
  .returns(({ total, retained, omitted, limit }) => ({
    within: (bug === "sample loses an entry" ? total.atMost(retained.plus(omitted)) : total.eq(retained.plus(omitted))).and(retained.atMost(limit)),
  }));

// The newest copy of each exact message comes before repeats; within each
// class the later entry wins, regardless of length. The caller keeps 64.
const priority = (bug?: PolicyBug) => fun("user sample priority")
  .inputs({ aDistinct: bool, bDistinct: bool, aIndex: nat, bIndex: nat })
  .returns(({ aDistinct, bDistinct, aIndex, bIndex }) => {
    const sameClass = aDistinct.and(bDistinct).or(aDistinct.not().and(bDistinct.not()));
    const firstClass = bug === "duplicates crowd distinct users" ? aDistinct.not().and(bDistinct) : aDistinct.and(bDistinct.not());
    const newer = bug === "older users win" ? aIndex.lt(bIndex) : aIndex.gt(bIndex);
    return { before: firstClass.or(sameClass.and(newer)) };
  });

// Under byte pressure, one older short message can replace the oldest retained
// entry, but never a distinct entry with a repeated copy.
const shortSwap = (bug?: PolicyBug) => fun("short user swap")
  .inputs({ pressure: bool, sameClass: bool, candidateBytes: nat, slotBytes: nat })
  .returns(({ pressure, sameClass, candidateBytes, slotBytes }) => ({
    swap: (bug === "short swap without pressure" ? pressure.not() : pressure).and(sameClass)
      .and(bug === "long replacement" ? candidateBytes.gt(slotBytes) : candidateBytes.lt(slotBytes)),
  }));

export const policyKernels = (bug?: PolicyBug): Kernel[] => {
  const sa = sample(bug), p = priority(bug), s = shortSwap(bug);
  return [
    { id: "sampleWithin", fun: sa, decisions: [
      sa.law("sample_accounting: retained plus omitted is the total, and the retained fit the limit", () => [], ({ within }, e) => within.implies(e.total.eq(e.retained.plus(e.omitted)).and(e.retained.atMost(e.limit)))),
      sa.law("sample_complete: exact accounting within the limit is accepted", () => [], ({ within }, e) => e.total.eq(e.retained.plus(e.omitted)).and(e.retained.atMost(e.limit)).implies(within)),
    ] },
    { id: "userPriority", fun: p, decisions: [
      p.law("distinct_first: a distinct message precedes a repeated message",
        ({ aDistinct, bDistinct }) => [aDistinct, bDistinct.not()], ({ before }) => before),
      p.law("duplicate_last: a repeated message does not precede a distinct message",
        ({ aDistinct, bDistinct }) => [aDistinct.not(), bDistinct], ({ before }) => before.not()),
      p.law("newer_first: within a class the later message ranks first",
        ({ aDistinct, bDistinct, aIndex, bIndex }) => [aDistinct.and(bDistinct).or(aDistinct.not().and(bDistinct.not())), aIndex.gt(bIndex)], ({ before }) => before),
      p.law("older_last: within a class the earlier message never precedes the later",
        ({ aDistinct, bDistinct, aIndex, bIndex }) => [aDistinct.and(bDistinct).or(aDistinct.not().and(bDistinct.not())), aIndex.lt(bIndex)], ({ before }) => before.not()),
      p.law("same_entry: an entry never precedes itself",
        ({ aDistinct, bDistinct, aIndex, bIndex }) => [aDistinct.and(bDistinct).or(aDistinct.not().and(bDistinct.not())), aIndex.eq(bIndex)], ({ before }) => before.not()),
    ] },
    { id: "userShortSwap", fun: s, decisions: [
      s.law("only_under_pressure: without byte pressure no short-message swap occurs",
        ({ pressure }) => [pressure.not()], ({ swap }) => swap.not()),
      s.law("same_class: a swap cannot displace a distinct message with a duplicate",
        ({ sameClass }) => [sameClass.not()], ({ swap }) => swap.not()),
      s.law("shorter_replaces: under pressure a shorter candidate in the same class is selected",
        ({ pressure, sameClass, candidateBytes, slotBytes }) => [pressure, sameClass, candidateBytes.lt(slotBytes)], ({ swap }) => swap),
      s.law("not_shorter_kept_out: a candidate no shorter than the slot is not selected",
        ({ candidateBytes, slotBytes }) => [candidateBytes.lt(slotBytes).not()], ({ swap }) => swap.not()),
    ] },
  ];
};

export const POLICY_BUGS: PolicyBug[] = ["sample loses an entry", "older users win", "duplicates crowd distinct users", "short swap without pressure", "long replacement"];
