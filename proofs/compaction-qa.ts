// QA's counting and result-order rules. Text matching and operation identity stay
// outside the machines: the caller supplies one fact per probe and result.
import { bool, fun, nat, rule, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

type QaBug = "admit one missing" | "call order" | "count a failed probe";

const admission = (bug?: QaBug) => fun("compaction QA admission")
  .inputs({ required: nat, satisfied: nat, footer: nat })
  .returns(({ required, satisfied, footer }) => ({
    admitted: when(required.gt(0).and(footer.eq(1)).and(
      bug === "admit one missing" ? satisfied.plus(1).atLeast(required) : satisfied.eq(required),
    ), 1, 0),
  }));

const tally = (bug?: QaBug) => rule("compaction QA tally")
  .inputs({ pass: bool, isFooter: bool })
  .state({ required: 0, satisfied: 0, footer: 0 })
  .step(({ required, satisfied, footer, pass, isFooter }) => ({
    required: required.plus(1),
    satisfied: when(bug === "count a failed probe" ? pass.not() : pass, satisfied.plus(1), satisfied),
    footer: when(isFooter, 1, footer),
  }));

// seen is result order, not call order. latest is a ghost reference updated
// on every successful modification; chosen is the value the host reads.
const modifications = (bug?: QaBug) => rule("latest successful modification")
  .inputs({ success: bool, callIndex: nat })
  .state({ seen: 0, chosen: 0, chosenCall: 0, latest: 0, chosenSuccess: 0 })
  .flags(({ success, callIndex, chosenCall }) => ({
    select: bug === "call order" ? success.and(callIndex.gt(chosenCall)) : success,
  }))
  .step(({ seen, chosen, chosenCall, latest, chosenSuccess, callIndex, success, select }) => ({
    seen: seen.plus(1),
    chosen: when(select, seen.plus(1), chosen),
    chosenCall: when(select, callIndex, chosenCall),
    latest: when(success, seen.plus(1), latest),
    chosenSuccess: when(select, 1, chosenSuccess),
  }));

export const compactionQaKernels = (bug?: QaBug): Kernel[] => {
  const admit = admission(bug), count = tally(bug), last = modifications(bug);
  return [
    { id: "compactionQa", fun: admit, decisions: [
      admit.law("complete_with_footer: admit exactly when a footer probe exists and every required probe is satisfied", () => [],
        (out, input) => out.admitted.eq(when(input.required.gt(0).and(input.footer.eq(1))
          .and(input.satisfied.eq(input.required)), 1, 0))),
    ] },
    { id: "qaTally", rule: count, laws: [
      count.law("satisfied_bounded: satisfied probes never exceed required probes", ({ satisfied, required }) => satisfied.atMost(required)),
    ], stepLaws: [
      count.stepLaw("pass_counted: each passing probe increments satisfied", ({ satisfied }, after) => after.satisfied.eq(satisfied.plus(1)), ({ pass }) => pass),
      count.stepLaw("failure_not_counted: a failing probe never increments satisfied", ({ satisfied }, after) => after.satisfied.eq(satisfied), ({ pass }) => pass.not()),
    ] },
    { id: "qaLatestModification", rule: last, laws: [
      last.law("latest_success: the chosen result is the latest successful modification", ({ chosen, latest }) => chosen.eq(latest)),
      last.law("chosen_success: a nonzero chosen result was successful", ({ chosen, chosenSuccess }) => chosen.eq(0).or(chosenSuccess.eq(1))),
    ], stepLaws: [
      last.stepLaw("success_selected: a successful modification becomes the chosen result", ({ seen }, after) => after.chosen.eq(seen.plus(1)), ({ success }) => success),
      last.stepLaw("failure_ignored: a failed result cannot become the chosen result", ({ chosen }, after) => after.chosen.eq(chosen), ({ success }) => success.not()),
    ] },
  ];
};

export const COMPACTION_QA_BUGS: QaBug[] = ["admit one missing", "call order", "count a failed probe"];
