// The adapter visits every expected outcome in order, finding its next equal ID
// in the rebuilt sequence. Positions are one-based; zero means absent. This
// machine checks each pair and the suffix layout, not the adapter's ID equality
// or the fact that it visits every item. Those remain string/sequence tests.
import { all, bool, fun, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

type OrderBug = "allow a swap" | "allow an extra suffix outcome" | "shift a suffix position" | "apply a refusal" | "ignore an admission" | "refuse a valid pair";

const order = (bug?: OrderBug) => fun("restore order")
  .inputs({ previous: nat, position: nat, expectedPosition: nat, expectedFirst: nat, actualFirst: nat,
    expectedLength: nat, actualLength: nat, matches: bool })
  .returns(({ previous, position, expectedPosition, expectedFirst, actualFirst, expectedLength, actualLength, matches }) => {
    const layout = all(expectedFirst.gt(0), actualFirst.gt(0), expectedFirst.atMost(expectedLength), actualFirst.atMost(actualLength),
      bug === "allow an extra suffix outcome" ? actualLength.plus(expectedFirst).atLeast(expectedLength.plus(actualFirst))
        : actualLength.plus(expectedFirst).eq(expectedLength.plus(actualFirst)));
    const increasing = bug === "allow a swap" ? position.gt(0) : position.gt(previous);
    const aligned = expectedPosition.lt(expectedFirst).or(bug === "shift a suffix position"
      ? position.plus(expectedFirst).atLeast(expectedPosition.plus(actualFirst))
      : position.plus(expectedFirst).eq(expectedPosition.plus(actualFirst)));
    const admitted = all(layout, increasing, position.atMost(actualLength), expectedPosition.gt(0),
      expectedPosition.atMost(expectedLength), matches, aligned,
      bug === "refuse a valid pair" ? position.lt(actualLength) : position.atMost(actualLength));
    return { admitted, apply: bug === "apply a refusal" ? 1 : bug === "ignore an admission" ? 0 : when(admitted, 1, 0) };
  });

export const restoreOrderKernels = (bug?: OrderBug): Kernel[] => {
  const r = order(bug);
  return [{ id: "restoreOrder", fun: r, decisions: [
    r.law("relative_order: an admitted current outcome follows the preceding matched outcome", () => [],
      (o, e) => o.admitted.implies(e.position.gt(e.previous))),
    r.law("exact_suffix_length: an admitted layout has equal suffix lengths", () => [],
      (o, e) => o.admitted.implies(e.actualLength.plus(e.expectedFirst).eq(e.expectedLength.plus(e.actualFirst)))),
    r.law("suffix_positions: admitted current outcomes after restoration keep their suffix positions", () => [],
      (o, e) => o.admitted.and(e.expectedPosition.atLeast(e.expectedFirst)).implies(
        e.position.plus(e.expectedFirst).eq(e.expectedPosition.plus(e.actualFirst)))),
    r.law("refusal_unchanged: apply is 1 exactly when the comparison is admitted", () => [],
      (o) => o.admitted.not().implies(o.apply.eq(0)).and(o.admitted.implies(o.apply.eq(1)))),
    r.law("complete: every valid comparison is admitted and applied", (e) => [all(e.expectedFirst.gt(0), e.actualFirst.gt(0),
      e.expectedFirst.atMost(e.expectedLength), e.actualFirst.atMost(e.actualLength),
      e.actualLength.plus(e.expectedFirst).eq(e.expectedLength.plus(e.actualFirst)), e.position.gt(e.previous),
      e.position.atMost(e.actualLength), e.expectedPosition.gt(0), e.expectedPosition.atMost(e.expectedLength), e.matches,
      e.expectedPosition.lt(e.expectedFirst).or(e.position.plus(e.expectedFirst).eq(e.expectedPosition.plus(e.actualFirst))))],
      (o) => o.admitted.and(o.apply.eq(1))),
  ] }];
};

export const RESTORE_ORDER_BUGS: OrderBug[] = ["allow a swap", "allow an extra suffix outcome", "shift a suffix position", "apply a refusal", "ignore an admission", "refuse a valid pair"];
