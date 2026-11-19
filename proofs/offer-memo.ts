// The fabricOnly answer per loop and tool. Claude Code asks tool.offer once per tool before a
// loop's first request, which decides the model's list, and again at each call. A call must get
// the answer the list showed: otherwise a tool the model sees is refused, or one it was never
// shown runs. One machine per loop and tool, fresh per session (src/mod/index.ts drops them all at
// session.end, since /clear and a resume keep the process under a new session id).
//
// State: 0 not asked yet, 1 offered, 2 hidden. The first ask fixes the answer to the visibility
// verdict (proofs/tool-visibility.ts); every later ask returns it unchanged.
import { all, bool, rule, when, yes } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type OfferMemoBug =
  | "a call re-decides"
  | "the first ask ignores the verdict";

export const OFFER_UNASKED = 0, OFFER_OFFERED = 1, OFFER_HIDDEN = 2;

const memo = (bug?: OfferMemoBug) => rule("offer memo")
  .inputs({ verdict: bool })
  .state({ fixed: OFFER_UNASKED })
  .step(({ verdict, fixed }) => ({
    fixed: bug === "a call re-decides" ? when(verdict, OFFER_OFFERED, OFFER_HIDDEN)
      : bug === "the first ask ignores the verdict" ? when(fixed.eq(OFFER_UNASKED), OFFER_OFFERED, fixed)
      : when(fixed.eq(OFFER_UNASKED), when(verdict, OFFER_OFFERED, OFFER_HIDDEN), fixed),
  }));

export const offerMemoKernels = (bug?: OfferMemoBug): Kernel[] => {
  const m = memo(bug);
  return [{
    id: "offerMemo",
    rule: m,
    laws: [
      m.law("fixed_in_range: the answer is unasked, offered or hidden",
        ({ fixed }) => all(fixed.atLeast(OFFER_UNASKED), fixed.atMost(OFFER_HIDDEN))),
    ],
    stepLaws: [
      m.stepLaw("first_ask_takes_verdict: the first ask answers with the visibility verdict",
        (e, after) => e.fixed.eq(OFFER_UNASKED).implies(after.fixed.eq(when(e.verdict, OFFER_OFFERED, OFFER_HIDDEN))),
        () => yes),
      m.stepLaw("answer_stable: once answered, every later ask gets the same answer, whatever the verdict says now",
        (e, after) => e.fixed.ne(OFFER_UNASKED).implies(after.fixed.eq(e.fixed)),
        () => yes),
      m.stepLaw("always_answered: after any ask the answer is offered or hidden",
        (_e, after) => after.fixed.ne(OFFER_UNASKED),
        () => yes),
    ],
  }];
};

export const OFFER_MEMO_BUGS: OfferMemoBug[] = ["a call re-decides", "the first ask ignores the verdict"];
