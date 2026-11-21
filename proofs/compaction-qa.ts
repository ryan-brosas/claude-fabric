// This proves admission counts, not the meaning or source of a probe's text.
import { fun, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

type QaBug = "admit one missing";

const qa = (bug?: QaBug) => fun("compaction QA admission")
  .inputs({ required: nat, satisfied: nat, footer: nat })
  .returns(({ required, satisfied, footer }) => ({
    admitted: when(required.gt(0).and(footer.eq(1)).and(
      bug === "admit one missing" ? satisfied.plus(1).atLeast(required) : satisfied.eq(required),
    ), 1, 0),
  }));

export const compactionQaKernels = (bug?: QaBug): Kernel[] => {
  const rule = qa(bug);
  return [{ id: "compactionQa", fun: rule, decisions: [
    rule.law("complete_with_footer: admit exactly when a footer probe exists and every required probe is satisfied", () => [],
      (out, input) => out.admitted.eq(when(input.required.gt(0).and(input.footer.eq(1))
        .and(input.satisfied.eq(input.required)), 1, 0))),
  ] }];
};

export const COMPACTION_QA_BUGS: QaBug[] = ["admit one missing"];
