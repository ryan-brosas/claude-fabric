// Before the mod allocates or reads a transcript, it sends its byte size and a validity fact
// to this decision. The adapter marks a negative or non-safe-integer size invalid and supplies
// zero for the natural-valued size in that case. Both rebuild and kept-Read stubbing use it.
import { bool, fun, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type TranscriptReadBug = "reject the bound" | "read over the bound" | "read invalid sizes" | "never read";

const transcriptRead = (bug?: TranscriptReadBug) => fun("transcript read decision")
  .inputs({ size: nat, limit: nat, valid: bool })
  .returns(({ size, limit, valid }) => {
    const within = bug === "reject the bound" ? size.lt(limit) : size.atMost(limit);
    const eligible = bug === "read over the bound" ? valid
      : bug === "read invalid sizes" ? within : valid.and(within);
    return { read: bug === "never read" ? 0 : when(eligible, 1, 0) };
  });

export const transcriptReadKernels = (bug?: TranscriptReadBug): Kernel[] => {
  const decision = transcriptRead(bug);
  return [{ id: "transcriptRead", fun: decision, decisions: [
    decision.law("within_is_read: a valid size within the bound is read", () => [],
      (o, e) => e.valid.and(e.size.atMost(e.limit)).implies(o.read.eq(1))),
    decision.law("over_is_not_read: a size over the bound is never read", () => [],
      (o, e) => e.size.gt(e.limit).implies(o.read.eq(0))),
    decision.law("invalid_is_not_read: an invalid size is never read", () => [],
      (o, e) => e.valid.not().implies(o.read.eq(0))),
  ] }];
};

export const TRANSCRIPT_READ_BUGS: TranscriptReadBug[] = [
  "reject the bound", "read over the bound", "read invalid sizes", "never read",
];
