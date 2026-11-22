// For every assistant message with a tool call on the active chain, each other tool call of that same message and each uniquely matching result row belongs at its original position; ambiguous attribution refuses the rebuild.
// The adapter supplies counts and positions from transcript rows; these machines decide admission and what to insert.
import { all, bool, fun, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

type Bug = "empty group" | "invalid prefix count" | "no anchor" | "missing metadata" | "different request" | "duplicate block" | "unconnected" |
  "duplicate call" | "duplicate result" | "wrong source" | "orphan result" | "duplicate existing" | "duplicate outcome" |
  "missing call before result" | "wrong insertion" | "refuse valid pair" | "refuse valid group" | "reorder neighbor" |
  "cross existing" | "result before call" | "refuse valid order" | "cover wrong call" | "refuse covered call" |
  "ignore owner conflict" | "refuse matching owner" | "refuse fresh owner";

const group = (bug?: Bug) => fun("sibling group")
  .inputs({ anchored: bool, rows: nat, metadata: nat, requests: nat, indices: nat, connected: nat })
  .returns((x) => ({ admitted: all(bug === "no anchor" ? x.anchored.or(x.anchored.not()) : x.anchored,
    bug === "empty group" ? x.rows.atLeast(0) : x.rows.gt(0), bug === "missing metadata" ? x.metadata.atMost(x.rows) : x.metadata.eq(x.rows),
    bug === "different request" ? x.requests.atMost(x.rows) : x.requests.eq(x.rows),
    bug === "duplicate block" ? x.indices.atMost(x.rows) : x.indices.eq(x.rows),
    bug === "unconnected" ? x.connected.atMost(x.rows) : x.connected.eq(x.rows),
    bug === "refuse valid group" ? x.rows.gt(1) : x.rows.atLeast(0)) }));

const pair = (bug?: Bug) => fun("sibling pair")
  .inputs({ calls: nat, results: nat, sources: nat, stray: nat, baseCalls: nat, prefixCalls: nat, existing: nat, active: bool, tail: nat })
  .returns((x) => {
    const valid = all(bug === "duplicate call" ? x.calls.atLeast(1) : x.calls.eq(1),
      bug === "duplicate result" ? x.results.atLeast(1) : x.results.eq(1),
      bug === "wrong source" ? x.sources.atMost(x.results) : x.sources.eq(1),
      bug === "orphan result" ? x.stray.atLeast(0) : x.stray.eq(0),
      bug === "duplicate existing" ? x.baseCalls.atLeast(0) : x.baseCalls.atMost(1),
      bug === "duplicate outcome" ? x.existing.atLeast(0) : x.existing.atMost(1),
      bug === "invalid prefix count" ? x.prefixCalls.atLeast(0) : x.prefixCalls.atMost(x.baseCalls),
      bug === "missing call before result" ? x.baseCalls.atLeast(0)
        : x.existing.gt(0).or(x.baseCalls.eq(0)).or(x.prefixCalls.gt(0)),
      bug === "refuse valid pair" ? x.existing.eq(0) : x.baseCalls.atLeast(0));
    const covered = all(x.calls.eq(1), bug === "cover wrong call" ? x.results.atLeast(0) : x.results.eq(0),
      x.active, x.baseCalls.eq(1), x.prefixCalls.eq(1), x.existing.eq(1), x.tail.eq(1));
    return { admitted: valid, covered: bug === "refuse covered call" ? 0 : when(covered, 1, 0),
      addCall: bug === "wrong insertion" ? 0 : when(valid.and(x.baseCalls.eq(0)), 1, 0),
      addResult: when(valid.and(x.existing.eq(0)), 1, 0) };
  });

const owner = (bug?: Bug) => fun("sibling owner")
  .inputs({ seen: bool, same: bool })
  .returns((x) => ({ admitted: bug === "ignore owner conflict" ? x.seen.or(x.seen.not())
    : bug === "refuse matching owner" ? x.seen.not() : bug === "refuse fresh owner" ? x.seen.and(x.same)
      : x.seen.not().or(x.same) }));

const order = (bug?: Bug) => fun("sibling insertion order")
  .inputs({ previous: nat, position: nat, next: nat, misplaced: nat, callPosition: nat, resultPosition: nat })
  .returns((x) => ({ admitted: all(bug === "reorder neighbor" ? x.position.gt(0) : x.position.gt(x.previous),
    x.next.gt(x.position), bug === "cross existing" ? x.misplaced.atLeast(0) : x.misplaced.eq(0),
    bug === "result before call" ? x.resultPosition.gt(0) : x.resultPosition.gt(x.callPosition),
    bug === "refuse valid order" ? x.position.gt(1) : x.position.gt(0)) }));

export const siblingRestorationKernels = (bug?: Bug): Kernel[] => {
  const g = group(bug), p = pair(bug), o = order(bug), w = owner(bug);
  return [
    { id: "siblingGroup", fun: g, decisions: [
      g.law("anchored: an admitted group has an on-chain call", () => [], (a, x) => a.admitted.implies(x.anchored)),
      g.law("nonempty: an admitted group has a row", () => [], (a, x) => a.admitted.implies(x.rows.gt(0))),
      g.law("metadata: each group row has block and request metadata", () => [], (a, x) => a.admitted.implies(x.metadata.eq(x.rows))),
      g.law("request: all group rows have the same request", () => [], (a, x) => a.admitted.implies(x.requests.eq(x.rows))),
      g.law("unique_block: one group row per block index", () => [], (a, x) => a.admitted.implies(x.indices.eq(x.rows))),
      g.law("ancestry: each group row connects to the active group", () => [], (a, x) => a.admitted.implies(x.connected.eq(x.rows))),
      g.law("complete: every valid group is admitted", (x) => [all(x.anchored, x.rows.gt(0), x.metadata.eq(x.rows),
        x.requests.eq(x.rows), x.indices.eq(x.rows), x.connected.eq(x.rows))], (a) => a.admitted),
    ] },
    { id: "siblingPair", fun: p, decisions: [
      p.law("tail_covered: only a unique active prefix call with one tail outcome needs no historical pair", () => [],
        (a, x) => a.covered.eq(when(all(x.calls.eq(1), x.results.eq(0), x.active, x.baseCalls.eq(1),
          x.prefixCalls.eq(1), x.existing.eq(1), x.tail.eq(1)), 1, 0))),
      p.law("unique_call: an admitted id has exactly one source call", () => [], (a, x) => a.admitted.implies(x.calls.eq(1))),
      p.law("unique_result: an admitted id has exactly one source result", () => [], (a, x) => a.admitted.implies(x.results.eq(1))),
      p.law("matched_source: the result is attributed to its call", () => [], (a, x) => a.admitted.implies(x.sources.eq(1))),
      p.law("no_orphans: the source call has no unrelated result", () => [], (a, x) => a.admitted.implies(x.stray.eq(0))),
      p.law("no_duplicate_call: the rebuilt base has at most one call", () => [], (a, x) => a.admitted.implies(x.baseCalls.atMost(1))),
      p.law("prefix_within_base: prefix calls are included in the base", () => [], (a, x) => a.admitted.implies(x.prefixCalls.atMost(x.baseCalls))),
      p.law("call_before_new_result: a new result cannot precede an existing tail call", () => [], (a, x) => a.admitted.implies(
        x.existing.gt(0).or(x.baseCalls.eq(0)).or(x.prefixCalls.gt(0)))),
      p.law("one_outcome: an admitted call has exactly one existing or inserted outcome", () => [],
        (a, x) => a.admitted.implies(x.existing.plus(a.addResult).eq(1))),
      p.law("decisions: admitted missing calls and outcomes are inserted exactly once, and refusals insert neither", () => [],
        (a, x) => a.addCall.eq(when(a.admitted.and(x.baseCalls.eq(0)), 1, 0)).and(
          a.addResult.eq(when(a.admitted.and(x.existing.eq(0)), 1, 0)))),
      p.law("complete: every valid pair is admitted", (x) => [all(x.calls.eq(1), x.results.eq(1), x.sources.eq(1),
        x.stray.eq(0), x.baseCalls.atMost(1), x.existing.atMost(1), x.prefixCalls.atMost(x.baseCalls),
        x.existing.gt(0).or(x.baseCalls.eq(0)).or(x.prefixCalls.gt(0)))], (a) => a.admitted),
    ] },
    { id: "siblingOwner", fun: w, decisions: [
      w.law("fresh: an unseen id is admitted", () => [], (a, x) => x.seen.not().implies(a.admitted)),
      w.law("copy: the same owner is admitted", () => [], (a, x) => x.seen.and(x.same).implies(a.admitted)),
      w.law("conflict: a different owner is refused", () => [], (a, x) => x.seen.and(x.same.not()).implies(a.admitted.not())),
    ] },
    { id: "siblingOrder", fun: o, decisions: [
      o.law("neighbors: a restored row falls between its original neighbors", () => [],
        (a, x) => a.admitted.implies(x.position.gt(x.previous).and(x.next.gt(x.position)))),
      o.law("preserve_order: no existing row crosses the inserted row", () => [], (a, x) => a.admitted.implies(x.misplaced.eq(0))),
      o.law("call_before_result: a source call precedes its result", () => [], (a, x) => a.admitted.implies(x.resultPosition.gt(x.callPosition))),
      o.law("complete: every valid insertion position is admitted", (x) => [all(x.position.gt(x.previous), x.next.gt(x.position),
        x.misplaced.eq(0), x.resultPosition.gt(x.callPosition))], (a) => a.admitted),
    ] },
  ];
};
export const SIBLING_RESTORATION_BUGS: Bug[] = ["empty group", "invalid prefix count", "no anchor", "missing metadata", "different request", "duplicate block", "unconnected",
  "duplicate call", "duplicate result", "wrong source", "orphan result", "duplicate existing", "duplicate outcome", "missing call before result",
  "wrong insertion", "refuse valid pair", "refuse valid group", "reorder neighbor", "cross existing", "result before call", "refuse valid order",
  "cover wrong call", "refuse covered call", "ignore owner conflict", "refuse matching owner", "refuse fresh owner"];
