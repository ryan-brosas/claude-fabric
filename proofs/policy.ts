// Copied from pi-fabric (MIT, Tom X Nguyen) proofs/policy.ts at d331f629; sampleWithin retained.
// The earlier-user gate checks a proposed selection in reverse source order.
import { all, bool, fun, min, nat, oneOf, rule, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type PolicyBug = "sample loses an entry" | "older non-reserved wins" | "two reserves" | "arbitrary opening"
  | "repeat displaces distinct" | "65 selected" | "lost occurrence" | "loss without notice required" | "notice may disappear";

const sample = (bug?: PolicyBug) => fun("sample within")
  .inputs({ total: nat, retained: nat, omitted: nat, limit: nat })
  .returns(({ total, retained, omitted, limit }) => ({
    within: (bug === "sample loses an entry" ? total.atMost(retained.plus(omitted)) : total.eq(retained.plus(omitted))).and(retained.atMost(limit)),
  }));

// phase: 0 collecting, 1 selection accepted, 2 refused, 3 final text accepted.
// Every row must arrive exactly once, newest first, with its source ordinal.
// The adapter supplies distinct from exact-text equality; the gate checks that
// a proposed selection obeys its ordering and that no row was skipped.
const userSelection = (bug?: PolicyBug) => rule("earlier user selection")
  .params({ total: nat })
  .inputs({ op: oneOf("row", "commit", "finish"), index: nat, selected: bool, distinct: bool, notice: bool })
  .state({ phase: 0, seen: 0, kept: 0, omitted: 0, missedDistinct: 0, missedRepeat: 0, pickedRepeat: 0, noticeRequired: 0 })
  .flags(({ total, phase, seen, kept, omitted, missedDistinct, missedRepeat, pickedRepeat, noticeRequired, index, selected, distinct, notice }) => {
    const opening = total.gt(64).and(bug === "two reserves" ? index.atMost(1)
      : bug === "arbitrary opening" ? index.eq(1) : index.eq(0));
    const nonOpening = opening.not();
    return {
      rowOK: all(phase.eq(0), index.plus(seen).plus(1).eq(total),
        total.atMost(64).or(index.ne(0)).or(selected),
        bug === "older non-reserved wins" ? selected.or(selected.not()) : selected.and(distinct).and(nonOpening).and(missedDistinct.gt(0)).not(),
        selected.and(distinct.not()).and(nonOpening).and(missedRepeat.gt(0)).not(),
        kept.plus(when(selected, 1, 0)).atMost(bug === "65 selected" ? 65 : 64)),
      complete: all(phase.eq(0),
        bug === "lost occurrence" ? seen.atMost(total) : seen.eq(total).and(kept.plus(omitted).eq(total)),
        kept.eq(min(total, bug === "65 selected" ? 65 : 64)),
        bug === "repeat displaces distinct" ? selected.or(selected.not()) : missedDistinct.eq(0).or(pickedRepeat.eq(0))),
      finalOK: all(phase.eq(1), bug === "notice may disappear" ? notice.or(notice.not()) : noticeRequired.eq(0).or(notice)),
      opening,
    };
  })
  .step(({ op, rowOK, complete, finalOK, opening, index: _index, selected, distinct, seen, kept, omitted, missedDistinct, missedRepeat, pickedRepeat, noticeRequired }) => ({
    phase: op.match({ row: () => when(rowOK, 0, 2), commit: () => when(complete, 1, 2), finish: () => when(finalOK, 3, 2) }),
    seen: when(op.is("row"), seen.plus(1), seen),
    kept: when(op.is("row").and(selected), kept.plus(1), kept),
    omitted: when(op.is("row").and(selected.not()), omitted.plus(1), omitted),
    missedDistinct: when(all(op.is("row"), selected.not(), distinct, opening.not()), missedDistinct.plus(1), missedDistinct),
    missedRepeat: when(all(op.is("row"), selected.not(), distinct.not(), opening.not()), missedRepeat.plus(1), missedRepeat),
    pickedRepeat: when(all(op.is("row"), selected, distinct.not(), opening.not()), pickedRepeat.plus(1), pickedRepeat),
    noticeRequired: when(op.is("commit"), bug === "loss without notice required" ? 0 : when(omitted.gt(0), 1, 0), noticeRequired),
  }));

export const policyKernels = (bug?: PolicyBug): Kernel[] => {
  const sa = sample(bug), r = userSelection(bug);
  return [
    { id: "sampleWithin", fun: sa, decisions: [
      sa.law("sample_accounting: retained plus omitted is the total, and the retained fit the limit", () => [], ({ within }, e) => within.implies(e.total.eq(e.retained.plus(e.omitted)).and(e.retained.atMost(e.limit)))),
      sa.law("sample_complete: exact accounting within the limit is accepted", () => [], ({ within }, e) => e.total.eq(e.retained.plus(e.omitted)).and(e.retained.atMost(e.limit)).implies(within)),
    ] },
    { id: "userSelection", rule: r, stepLaws: [
      r.stepLaw("ordinal_once: rows arrive in exact reverse source order", (e, a) => e.op.is("row").and(a.phase.eq(0)).implies(e.index.plus(e.seen).plus(1).eq(e.total))),
      r.stepLaw("opening_reserved: over 64 the first eligible occurrence is selected", (e, a) => all(e.op.is("row"), a.phase.eq(0), e.total.gt(64), e.index.eq(0)).implies(e.selected)),
      r.stepLaw("distinct_recency: only the opening may follow an omitted newer distinct", (e, a) => all(e.op.is("row"), a.phase.eq(0), e.selected, e.distinct, e.missedDistinct.gt(0)).implies(e.total.gt(64).and(e.index.eq(0)))),
      r.stepLaw("repeat_recency: only the opening repeat may follow an omitted newer repeat", (e, a) => all(e.op.is("row"), a.phase.eq(0), e.selected, e.distinct.not(), e.missedRepeat.gt(0)).implies(e.total.gt(64).and(e.index.eq(0)))),
      r.stepLaw("selection_cap: no accepted row raises the selected count above 64", (e, a) => e.op.is("row").and(a.phase.eq(0)).implies(a.kept.atMost(64))),
      r.stepLaw("complete_accounting: commit needs every ordinal and accounts each as selected or omitted", (e, a) => e.op.is("commit").and(a.phase.eq(1)).implies(all(e.seen.eq(e.total), e.kept.plus(e.omitted).eq(e.total), e.kept.eq(min(e.total, 64))))),
      r.stepLaw("distinct_before_repeats: commit refuses a repeat outside the reserve while a distinct is omitted", (e, a) => e.op.is("commit").and(a.phase.eq(1)).implies(e.missedDistinct.eq(0).or(e.pickedRepeat.eq(0)))),
      r.stepLaw("notice_required: commit requires notice exactly when occurrences were omitted", (e, a) => e.op.is("commit").and(a.phase.eq(1)).implies(a.noticeRequired.eq(when(e.omitted.gt(0), 1, 0)))),
      r.stepLaw("notice_survives: final text is refused if required notice is absent", (e, a) => all(e.op.is("finish"), a.phase.eq(3), e.noticeRequired.gt(0)).implies(e.notice)),
    ] },
  ];
};

export const POLICY_BUGS: PolicyBug[] = ["sample loses an entry", "older non-reserved wins", "two reserves", "arbitrary opening", "repeat displaces distinct", "65 selected", "lost occurrence", "loss without notice required", "notice may disappear"];
