// Copied from pi-fabric (MIT, Tom X Nguyen) proofs/context.ts at d331f629; dropped user staleness and its broken variants, which the summary here does not use, and replaced summaryAllocation with summaryCarry, which also allocates the summary a second compaction carries.
// What a compaction summary puts in front of the model. Two kernels, each a
// claim about context salience rather than about cut safety:
//
// - summaryCarry: the footer and the separators are reserved, the newest blocks
//   (the compaction request, the recent directions, the earlier messages) keep
//   their bytes, and the room they leave is split between the earlier summary a
//   second compaction carries and operational residue (files, activity,
//   failures, transcript). History keeps the reserve the caller passes (half of
//   that room), so the carried summary can never starve the record of what just
//   happened.
// - failureLedger: every failure is accounted exactly once as open, aged or
//   resolved. Unresolved failures from the newest window are itemized first;
//   failures an earlier summary already itemized fill only the room they leave.
import { all, bool, fun, min, nat, rule, when, yes } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type ContextBug =
  | "the carry is allocated outside the ceiling"
  | "the carry crowds out the newest blocks"
  | "the carry starves history"
  | "history is allocated before the carry"
  | "a history block exceeds its remaining room"
  | "literals exceed their remaining room"
  | "aged failures vanish"
  | "aged failures crowd out fresh ones"
  | "itemized failures ignore the limit"
  | "resolved failures stay open";

/** Byte allocation inside the summary ceiling. Demands are the footer and
 * separators to reserve, the capped sizes of the newest protected blocks, the
 * earlier summary a second compaction carries, and the operational blocks.
 * `reserve` is the room history is guaranteed out of what the newest blocks
 * leave; the summary passes half of that room. */
const carry = (bug?: ContextBug) => fun("summary carry")
  .params({ reserve: nat })
  .inputs({ limit: nat, footer: nat, newest: nat, earlier: nat, history: nat })
  .returns(({ limit, footer, newest, earlier, history, reserve }) => {
    const footerBytes = min(footer, limit);
    const room = limit.minus(footerBytes);
    if (bug === "the carry is allocated outside the ceiling") {
      const newestBytes = min(newest, room);
      return { footerBytes, newestBytes, carryBytes: earlier, historyBytes: min(history, room.minus(newestBytes)) };
    }
    if (bug === "the carry crowds out the newest blocks") {
      const carryBytes = min(earlier, room);
      const newestBytes = min(newest, room.minus(carryBytes));
      return { footerBytes, newestBytes, carryBytes, historyBytes: min(history, room.minus(newestBytes).minus(carryBytes)) };
    }
    const newestBytes = bug === "a history block exceeds its remaining room" || bug === "literals exceed their remaining room" ? newest : min(newest, room);
    const older = room.minus(newestBytes);
    if (bug === "the carry starves history") {
      const carryBytes = min(earlier, older);
      return { footerBytes, newestBytes, carryBytes, historyBytes: min(history, older.minus(carryBytes)) };
    }
    if (bug === "history is allocated before the carry") {
      const historyBytes = min(history, older);
      return { footerBytes, newestBytes, carryBytes: min(earlier, older.minus(historyBytes)), historyBytes };
    }
    // History is guaranteed its reserve; the carry takes the rest up to its own
    // demand, and whatever the carry does not need flows back to history.
    const carryBytes = min(earlier, older.minus(min(history, reserve)));
    return { footerBytes, newestBytes, carryBytes, historyBytes: min(history, older.minus(carryBytes)) };
  });

/** Production folds fresh failures newest first, then aged ones newest first,
 * then resolved ones. `skipped` counts fresh open failures left without room. */
const ledger = (bug?: ContextBug) => rule("failure ledger")
  .params({ limit: nat })
  .inputs({ fresh: bool, resolved: bool })
  .state({ total: 0, open: 0, aged: 0, settled: 0, itemized: 0, skipped: 0 })
  .flags(({ fresh, resolved, itemized, skipped, limit }) => ({
    isOpen: bug === "resolved failures stay open" ? fresh : resolved.not().and(fresh),
    isAged: resolved.not().and(fresh.not()),
    room: bug === "itemized failures ignore the limit" ? yes : itemized.lt(limit),
    agedAllowed: bug === "aged failures crowd out fresh ones" ? yes : skipped.eq(0),
  }))
  .step(({ resolved, total, open, aged, settled, itemized, skipped, isOpen, isAged, room, agedAllowed }) => ({
    total: total.plus(1),
    open: when(isOpen, open.plus(1), open),
    aged: bug === "aged failures vanish" ? aged : when(isAged, aged.plus(1), aged),
    settled: when(resolved.and(isOpen.not()), settled.plus(1), settled),
    itemized: when(room.and(isOpen.or(isAged.and(agedAllowed))), itemized.plus(1), itemized),
    skipped: when(isOpen.and(room.not()), skipped.plus(1), skipped),
  }));

export const contextKernels = (bug?: ContextBug): Kernel[] => {
  const c = carry(bug), l = ledger(bug);
  return [
    { id: "summaryCarry", fun: c, decisions: [
      c.law("carry_within: the footer, the newest blocks, the carried summary and history stay within the ceiling", () => [],
        ({ footerBytes, newestBytes, carryBytes, historyBytes }, { limit }) =>
          footerBytes.plus(newestBytes).plus(carryBytes).plus(historyBytes).atMost(limit)),
      c.law("newest_kept: the newest directions, the compaction request and the footer keep their bytes while the ceiling holds them",
        ({ footer, newest, limit }) => all(footer.atMost(limit), newest.atMost(limit.minus(footer))),
        ({ footerBytes, newestBytes }, { footer, newest }) => all(footerBytes.eq(footer), newestBytes.eq(newest))),
      // The protected-room caller treats newest as user demand and carry as
      // earlier-reply demand, with history zero. These decisions wire that use
      // to the same compiled allocation as the whole summary.
      // boundedHistory calls this machine with its remaining room as limit and
      // the next block's desired bytes as newest, with no footer or carry.
      c.law("history_block_within_room: a history block receives at most the room left", () => [],
        ({ footerBytes, newestBytes }, { limit }) => newestBytes.atMost(limit.minus(footerBytes))),
      // The literals caller passes its bounded demand as newest and history's
      // remaining allocation as limit, with no footer, carry or history demand.
      c.law("literals_within_history: literals receive their demand up to the room left for history",
        ({ footer, earlier, history }) => all(footer.eq(0), earlier.eq(0), history.eq(0)),
        ({ newestBytes }, { limit, newest }) => newestBytes.eq(min(newest, limit))),
      c.law("users_first: newest demand receives the available room before carry", () => [],
        ({ footerBytes, newestBytes }, { limit, newest }) => newestBytes.eq(min(newest, limit.minus(footerBytes)))),
      c.law("replies_take_user_slack: with no history demand, carry takes the room newest demand leaves", ({ history }) => [history.eq(0)],
        ({ footerBytes, newestBytes, carryBytes }, { limit, earlier }) =>
          carryBytes.eq(min(earlier, limit.minus(footerBytes).minus(newestBytes)))),
      c.law("carry_takes_the_rest: the carried summary takes the older room history's reserve leaves, up to its own demand", () => [],
        ({ carryBytes, footerBytes, newestBytes }, { limit, earlier, history, reserve }) => {
          const older = limit.minus(footerBytes).minus(newestBytes);
          return carryBytes.eq(min(earlier, older.minus(min(history, reserve))));
        }),
      c.law("history_takes_what_the_carry_leaves: history receives the older room the carry leaves, up to its demand", () => [],
        ({ carryBytes, historyBytes, footerBytes, newestBytes }, { limit, history }) => {
          const older = limit.minus(footerBytes).minus(newestBytes);
          return historyBytes.eq(min(history, older.minus(carryBytes)));
        }),
      c.law("history_keeps_its_reserve: history keeps its reserve while the older room holds it, and never more than it asks", () => [],
        ({ historyBytes, footerBytes, newestBytes }, { limit, history, reserve }) => {
          const older = limit.minus(footerBytes).minus(newestBytes);
          return all(historyBytes.atMost(history), historyBytes.atLeast(min(history, min(reserve, older))));
        }),
    ] },
    {
      id: "failureLedger",
      rule: l,
      laws: [
        l.law("failures_conserved: every failure is open, aged or resolved, exactly once", ({ total, open, aged, settled }) =>
          total.eq(open.plus(aged).plus(settled))),
        l.law("itemized_bounded: itemized failures are unresolved and within the limit", ({ itemized, open, aged, limit }) =>
          itemized.atMost(open.plus(aged)).and(itemized.atMost(limit))),
        l.law("skipped_are_open: only fresh open failures are counted as left out", ({ skipped, open }) => skipped.atMost(open)),
      ],
      stepLaws: [
        l.stepLaw("resolved_never_itemized: a resolved failure is never itemized", ({ itemized }, after) =>
          after.itemized.eq(itemized), ({ resolved }) => resolved),
        l.stepLaw("open_itemized_with_room: a fresh open failure is itemized while room remains", ({ itemized }, after) =>
          after.itemized.eq(itemized.plus(1)), ({ fresh, resolved, itemized, limit }) => all(fresh, resolved.not(), itemized.lt(limit))),
        l.stepLaw("fresh_first: an aged failure takes no room once a fresh open failure was left out", ({ itemized }, after) =>
          after.itemized.eq(itemized), ({ fresh, resolved, skipped }) => all(fresh.not(), resolved.not(), skipped.gt(0))),
        l.stepLaw("aged_fills_room: an aged failure is itemized while room remains and no fresh one was left out", ({ itemized }, after) =>
          after.itemized.eq(itemized.plus(1)), ({ fresh, resolved, skipped, itemized, limit }) => all(fresh.not(), resolved.not(), skipped.eq(0), itemized.lt(limit))),
      ],
    },
  ];
};

export const CONTEXT_BUGS: ContextBug[] = [
  "the carry is allocated outside the ceiling",
  "the carry crowds out the newest blocks",
  "the carry starves history",
  "history is allocated before the carry",
  "a history block exceeds its remaining room",
  "literals exceed their remaining room",
  "aged failures vanish",
  "aged failures crowd out fresh ones",
  "itemized failures ignore the limit",
  "resolved failures stay open",
];
