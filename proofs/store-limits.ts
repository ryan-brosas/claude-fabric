// The store's limits and its commit rule, proved here. A write is checked as lengths only: the
// value's JSON text and the total the store holds without the key it replaces. The stage
// (src/stages/store.ts) folds real lengths into the compiled machine in
// src/stages/verified/store-limits.ts, so a write the machine refuses changes nothing and the host
// commits a run's staged writes only through the commit machine: a failed, timed-out or crashed
// program leaves the store as it was. A delta of several keys is applied as a sequence of these
// writes against the running total, so each key is checked at commit time the same way.
import { all, bool, fun, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type StoreBug =
  | "a value over its limit is stored"
  | "the total may pass its limit"
  | "a refused write still changes the store"
  | "an accepted write undercharges the store"
  | "a failed program commits anyway";

/** One write: `total` is the store without that key, `value` the JSON length replacing it. */
const write = (bug?: StoreBug) => fun("store write")
  .inputs({ value: nat, total: nat, valueLimit: nat, totalLimit: nat })
  .returns(({ value, total, valueLimit, totalLimit }) => {
    const next = total.plus(value);
    const accept = bug === "a value over its limit is stored" ? next.atMost(totalLimit)
      : bug === "the total may pass its limit" ? value.atMost(valueLimit)
      : all(value.atMost(valueLimit), next.atMost(totalLimit));
    const stored = bug === "a refused write still changes the store" ? next
      : bug === "an accepted write undercharges the store" ? total
      : when(accept, next, total);
    return {
      next,
      accept: when(accept, 1, 0),
      store: stored,
    };
  });

/** The commit: only a program that succeeded, and staged a write, changes the store. */
const commit = (bug?: StoreBug) => fun("store commit")
  .inputs({ success: bool, written: bool })
  .returns(({ success, written }) => ({
    committed: when(bug === "a failed program commits anyway" ? written : success.and(written), 1, 0),
  }));

export const storeLimitKernels = (bug?: StoreBug): Kernel[] => {
  const w = write(bug), c = commit(bug);
  return [
    {
      id: "storeWrite",
      fun: w,
      decisions: [
        w.law("value_within: an accepted write stores a value within its own limit", () => [],
          (o, e) => o.accept.eq(1).implies(e.value.atMost(e.valueLimit))),
        w.law("total_within: an accepted write leaves the store within its total limit", () => [],
          (o, e) => o.accept.eq(1).implies(o.store.atMost(e.totalLimit))),
        w.law("accepted_stores: an accepted write stores exactly the total plus its value", () => [],
          (o, e) => o.accept.eq(1).implies(all(o.next.eq(e.total.plus(e.value)), o.store.eq(e.total.plus(e.value))))),
        w.law("refused_keeps_store: a refused write leaves the store as it was", () => [],
          (o, e) => o.accept.eq(0).implies(o.store.eq(e.total))),
      ],
    },
    {
      id: "storeCommit",
      fun: c,
      decisions: [
        c.law("committed_only_on_success: a failed program commits nothing", () => [],
          (o, e) => o.committed.eq(1).implies(e.success)),
        c.law("committed_needs_writes: a run that staged nothing commits nothing", () => [],
          (o, e) => o.committed.eq(1).implies(e.written)),
        c.law("success_commits: a successful run's staged writes are committed", () => [],
          (o, e) => e.success.and(e.written).implies(o.committed.eq(1))),
      ],
    },
  ];
};

export const STORE_BUGS: StoreBug[] = [
  "a value over its limit is stored",
  "the total may pass its limit",
  "a refused write still changes the store",
  "an accepted write undercharges the store",
  "a failed program commits anyway",
];
