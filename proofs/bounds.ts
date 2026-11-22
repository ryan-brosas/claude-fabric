// Byte counts supplied by the string adapter; the machine accepts only an exact
// account of the output it built. The adapter owns UTF-8 measurement, string
// identity, marker construction and the retained prefix/suffix themselves.
// Concatenation can join surrogate halves, so output bytes can be fewer than
// the separately measured parts; the parts themselves must fit the cap.
import { all, bool, fun, min, nat, when, yes } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

type BoundsBug = "allow over cap" | "change fitting text" | "lose byte accounting" | "wrong marker count"
  | "refuse an exact cut" | "allocate past demand" | "allocate past remaining"
  | "wrong room" | "wrong halves" | "wrong loss" | "wrong overflow" | "wrong sample split"
  | "wrong protected room" | "accept wrong share" | "refuse correct share" | "refuse correct halves"
  | "wrong sample halves" | "wrong sample earliest" | "wrong sample latest" | "wrong sample omission"
  | "sample over limit" | "refuse exact sample" | "accept over budget" | "accept over demand"
  | "lose allocation sum" | "refuse valid allocation" | "refuse fitting text" | "overbook components"
  | "wrong first slot" | "wrong last slot" | "accept slot outside sample" | "accept impossible sample" | "refuse exact slot";

const textBound = (bug?: BoundsBug) => fun("bounded text")
  .inputs({ source: nat, cap: nat, head: nat, tail: nat, marker: nat, omitted: nat,
    markerCount: nat, output: nat, unchanged: bool, marked: bool })
  .returns(({ source, cap, head, tail, marker, omitted, markerCount, output, unchanged, marked }) => {
    const uncut = all(bug === "change fitting text" ? output.atMost(source) : unchanged.and(output.eq(source)),
      omitted.eq(0), head.eq(source), tail.eq(0), marker.eq(0));
    const cut = all(bug === "lose byte accounting" ? head.plus(tail).plus(omitted).atMost(source) : head.plus(tail).plus(omitted).eq(source),
      bug === "wrong marker count" ? marked.or(marked.not()) : marked.not().or(markerCount.eq(omitted)),
      output.atMost(head.plus(tail).plus(marker)),
      bug === "allow over cap" || bug === "overbook components" ? yes : head.plus(tail).plus(marker).atMost(cap));
    const within = bug === "allow over cap" ? output.atMost(cap.plus(1)) : output.atMost(cap);
    const accepted = all(within, when(source.atMost(cap), uncut, cut),
      bug === "refuse an exact cut" ? output.ne(cap) : yes,
      bug === "refuse fitting text" ? source.gt(cap) : yes);
    return { accepted };
  });

// One pass of protectedBudgets: give each item its share, then (in source
// order) its unmet demand up to the remaining room.
const allocation = (bug?: BoundsBug) => fun("protected item allocation")
  .inputs({ demand: nat, share: nat, base: nat, remaining: nat })
  .returns(({ demand, share, base, remaining }) => {
    const initial = min(demand, share);
    const extra = bug === "allocate past remaining" ? demand.minus(base)
      : bug === "allocate past demand" ? remaining : min(remaining, demand.minus(base));
    return { initial, afterInitial: remaining.minus(initial), extra, budget: base.plus(extra), remaining: remaining.minus(extra) };
  });

// The byte room, even split, loss and marker-growth retry used by the string
// builders. minus is saturating, matching the branches that reject negative room.
const plan = (bug?: BoundsBug) => fun("text byte plan")
  .inputs({ source: nat, cap: nat, marker: nat, head: nat, tail: nat, produced: nat, half: nat, lower: nat })
  .returns(({ source, cap, marker, head, tail, produced, half, lower }) => {
    const room = bug === "wrong room" ? cap : cap.minus(marker);
    const loss = bug === "wrong loss" ? source.minus(head).minus(tail).plus(1) : source.minus(head).minus(tail);
    const over = bug === "wrong overflow" ? produced : produced.minus(cap);
    const halves = all(half.times(2).atMost(room), room.atMost(half.times(2).plus(bug === "wrong halves" ? 2 : 1)),
      lower.times(2).atMost(cap), cap.atMost(lower.times(2).plus(bug === "wrong sample split" ? 2 : 1)),
      bug === "refuse correct halves" ? half.gt(0) : yes);
    return { room, half, other: room.minus(half), loss, over, retry: loss.plus(over),
      lower, upper: cap.minus(lower), valid: halves };
  });

// The host proposes quotient and remainder because the divisor is the dynamic
// number of items. The equation and remainder bound make the proposal unique.
const share = (bug?: BoundsBug) => fun("protected room and share")
  .inputs({ cap: nat, header: nat, count: nat, quotient: nat, remainder: nat })
  .returns(({ cap, header, count, quotient, remainder }) => {
    const room = bug === "wrong protected room" ? cap.minus(header) : cap.minus(header).minus(count.times(2));
    const exact = all(count.gt(0), quotient.mul(count).plus(remainder).eq(room),
      bug === "accept wrong share" ? remainder.atMost(count) : remainder.lt(count));
    return { room, valid: bug === "refuse correct share" ? exact.and(quotient.gt(0)) : exact };
  });

// Each emitted protected-item budget adds to the checked prefix and cannot exceed its demand.
const protectedTotal = (bug?: BoundsBug) => fun("protected allocation total")
  .inputs({ room: nat, used: nat, amount: nat, demand: nat })
  .returns(({ room, used, amount, demand }) => {
    const next = bug === "lose allocation sum" ? used : used.plus(amount);
    const valid = all(bug === "accept over budget" ? yes : next.atMost(room),
      bug === "accept over demand" ? yes : amount.atMost(demand),
      bug === "refuse valid allocation" ? amount.gt(0) : yes);
    return { next, valid };
  });

// Every retained slot identifies the matching first or last source position.
const samplePosition = (bug?: BoundsBug) => fun("addressed sample position")
  .inputs({ total: nat, first: nat, last: nat, position: nat, actual: nat })
  .returns(({ total, first, last, position, actual }) => {
    const firstExpected = bug === "wrong first slot" ? position.plus(1) : position;
    const lastExpected = total.minus(last).plus(position.minus(first)).plus(bug === "wrong last slot" ? 1 : 0);
    return { accepted: all(bug === "accept impossible sample" ? yes : first.plus(last).atMost(total),
      bug === "accept slot outside sample" ? yes : position.lt(first.plus(last)),
      when(position.lt(first), actual.eq(firstExpected), actual.eq(lastExpected)),
      bug === "refuse exact slot" ? actual.gt(0) : yes) };
  });

// The sample keeps the first ceiling half and the last floor half, and accounts for the middle.
const sample = (bug?: BoundsBug) => fun("addressed sample")
  .inputs({ total: nat, limit: nat, earliest: nat, latest: nat, omitted: nat, lower: nat, upper: nat })
  .returns(({ total, limit, earliest, latest, omitted, lower, upper }) => {
    const halves = all(lower.times(2).atMost(limit), limit.atMost(lower.times(2).plus(bug === "wrong sample halves" ? 2 : 1)),
      lower.plus(upper).eq(limit));
    const first = min(total, upper), last = min(total.minus(earliest), lower);
    const acceptsFirst = bug === "wrong sample earliest" ? earliest.atMost(first)
      : bug === "sample over limit" ? earliest.atMost(first.plus(1)) : earliest.eq(first);
    const acceptsLast = bug === "wrong sample latest" ? latest.atMost(last)
      : bug === "sample over limit" ? latest.atMost(last.plus(1)) : latest.eq(last);
    const acceptsOmitted = bug === "wrong sample omission" ? omitted.atMost(total.minus(earliest).minus(latest))
      : omitted.eq(total.minus(earliest).minus(latest));
    const within = bug === "sample over limit" ? earliest.plus(latest).atMost(limit.plus(1)) : earliest.plus(latest).atMost(limit);
    return { accepted: all(halves, acceptsFirst, acceptsLast, acceptsOmitted, within,
      bug === "refuse exact sample" ? earliest.gt(0) : yes) };
  });

export const boundsKernels = (bug?: BoundsBug): Kernel[] => {
  const t = textBound(bug), a = allocation(bug), p = plan(bug), q = share(bug), v = sample(bug), z = protectedTotal(bug), j = samplePosition(bug);
  return [
    { id: "samplePosition", fun: j, decisions: [
      j.law("slot_bounds: accepted sample and slot counts are within the source", () => [],
        (o,e) => o.accepted.implies(e.first.plus(e.last).atMost(e.total).and(e.position.lt(e.first.plus(e.last))))),
      j.law("slot_first: an accepted first-half slot is the same source position", () => [],
        (o,e) => o.accepted.and(e.position.lt(e.first)).implies(e.actual.eq(e.position))),
      j.law("slot_last: an accepted last-half slot is the matching source suffix position", () => [],
        (o,e) => o.accepted.and(e.position.atLeast(e.first)).implies(
          e.actual.eq(e.total.minus(e.last).plus(e.position.minus(e.first))))),
      j.law("slot_complete: every correctly positioned sample value is accepted", (e) => [all(
        e.first.plus(e.last).atMost(e.total), e.position.lt(e.first.plus(e.last)),
        when(e.position.lt(e.first), e.actual.eq(e.position),
          e.actual.eq(e.total.minus(e.last).plus(e.position.minus(e.first)))))], (o) => o.accepted),
    ] },
    { id: "protectedTotal", fun: z, decisions: [
      z.law("total_cap: an accepted allocation prefix stays within the available room", () => [],
        (o, e) => o.valid.implies(o.next.atMost(e.room))),
      z.law("total_demand: an accepted item budget stays within its own demand", () => [],
        (o, e) => o.valid.implies(e.amount.atMost(e.demand))),
      z.law("total_accounting: the next prefix includes the whole item budget", () => [],
        (o, e) => o.next.eq(e.used.plus(e.amount))),
      z.law("total_complete: every allocation within room and demand is accepted", (e) => [all(
        e.used.plus(e.amount).atMost(e.room), e.amount.atMost(e.demand))], (o) => o.valid),
    ] },
    { id: "addressedSample", fun: v, decisions: [
      v.law("sample_capped: an accepted sample retains at most the limit", () => [],
        (o, e) => o.accepted.implies(e.earliest.plus(e.latest).atMost(e.limit))),
      v.law("sample_halves: an accepted sample uses ceiling and floor halves", () => [],
        (o, e) => o.accepted.implies(all(e.lower.times(2).atMost(e.limit), e.limit.atMost(e.lower.times(2).plus(1)), e.lower.plus(e.upper).eq(e.limit)))),
      v.law("sample_earliest: the earliest half fills first", () => [],
        (o, e) => o.accepted.implies(e.earliest.eq(min(e.total, e.upper)))),
      v.law("sample_latest: the latest half fills from the remaining entries", () => [],
        (o, e) => o.accepted.implies(e.latest.eq(min(e.total.minus(e.earliest), e.lower)))),
      v.law("sample_conserved: retained and omitted entries sum to the total", () => [],
        (o, e) => o.accepted.implies(e.earliest.plus(e.latest).plus(e.omitted).eq(e.total))),
      v.law("sample_complete: exact sample counts and halves are accepted", (e) => [all(e.lower.times(2).atMost(e.limit),
        e.limit.atMost(e.lower.times(2).plus(1)), e.lower.plus(e.upper).eq(e.limit), e.earliest.eq(min(e.total, e.upper)),
        e.latest.eq(min(e.total.minus(e.earliest), e.lower)), e.omitted.eq(e.total.minus(e.earliest).minus(e.latest)))],
        (o) => o.accepted),
    ] },
    { id: "textBytePlan", fun: p, decisions: [
      p.law("room_exact: marker bytes are reserved from the cap", () => [], (o, e) => o.room.eq(e.cap.minus(e.marker))),
      p.law("even_split: an accepted head gets the floor half and head plus tail equals the room", () => [],
        (o) => o.valid.implies(all(o.half.times(2).atMost(o.room), o.room.atMost(o.half.times(2).plus(1)), o.half.plus(o.other).eq(o.room)))),
      p.law("sample_split: an accepted latest half rounds down and earliest takes the remainder", () => [],
        (o, e) => o.valid.implies(all(o.lower.times(2).atMost(e.cap), e.cap.atMost(o.lower.times(2).plus(1)), o.lower.plus(o.upper).eq(e.cap)))),
      p.law("halves_complete: the correct halves are accepted", (e) => [all(e.half.times(2).atMost(e.cap.minus(e.marker)),
        e.cap.minus(e.marker).atMost(e.half.times(2).plus(1)), e.lower.times(2).atMost(e.cap), e.cap.atMost(e.lower.times(2).plus(1)))],
        (o) => o.valid),
      p.law("loss_exact: the omission is the source less head and tail", () => [],
        (o, e) => o.loss.eq(e.source.minus(e.head).minus(e.tail))),
      p.law("retry_exact: marker growth is added to the next omission estimate", () => [],
        (o, e) => o.over.eq(e.produced.minus(e.cap)).and(o.retry.eq(o.loss.plus(o.over)))),
    ] },
    { id: "protectedShare", fun: q, decisions: [
      q.law("protected_room: framing and separators are reserved before item allocation", () => [],
        (o, e) => o.room.eq(e.cap.minus(e.header).minus(e.count.times(2)))),
      q.law("share_exact: an accepted share and remainder divide the room exactly", () => [],
        (o, e) => o.valid.implies(all(e.count.gt(0), e.quotient.mul(e.count).plus(e.remainder).eq(o.room), e.remainder.lt(e.count)))),
      q.law("share_complete: an exact share and remainder are accepted", (e) => [all(e.count.gt(0),
        e.quotient.mul(e.count).plus(e.remainder).eq(e.cap.minus(e.header).minus(e.count.times(2))), e.remainder.lt(e.count))],
        (o) => o.valid),
    ] },
    { id: "boundedText", fun: t, decisions: [
      t.law("capped: an accepted text never exceeds its byte cap", () => [],
        (o, e) => o.accepted.implies(e.output.atMost(e.cap))),
      t.law("untouched: a fitting accepted text is unchanged and has no omission", () => [],
        (o, e) => o.accepted.and(e.source.atMost(e.cap)).implies(e.unchanged.and(e.output.eq(e.source), e.omitted.eq(0)))),
      t.law("removed: on a cut the retained bytes and omitted bytes equal the source", () => [],
        (o, e) => o.accepted.and(e.source.gt(e.cap)).implies(e.head.plus(e.tail).plus(e.omitted).eq(e.source))),
      t.law("marker_count: a printed omission count equals the removed bytes", () => [],
        (o, e) => o.accepted.and(e.source.gt(e.cap)).and(e.marked).implies(e.markerCount.eq(e.omitted))),
      t.law("head_tail_room: retained head, tail and marker together fit the cap", () => [],
        (o, e) => o.accepted.and(e.source.gt(e.cap)).implies(e.head.plus(e.tail).plus(e.marker).atMost(e.cap))),
      t.law("complete_uncut: fitting unchanged text is accepted", (e) => [all(e.source.atMost(e.cap),
        e.unchanged, e.output.eq(e.source), e.omitted.eq(0), e.head.eq(e.source), e.tail.eq(0), e.marker.eq(0))],
        (o) => o.accepted),
      t.law("complete_cut: an exact cut within the cap is accepted", (e) => [all(e.source.gt(e.cap),
        e.output.atMost(e.cap), e.head.plus(e.tail).plus(e.omitted).eq(e.source),
        e.marked.not().or(e.markerCount.eq(e.omitted)), e.output.atMost(e.head.plus(e.tail).plus(e.marker)),
        e.head.plus(e.tail).plus(e.marker).atMost(e.cap))],
        (o) => o.accepted),
    ] },
    { id: "protectedItem", fun: a, decisions: [
      a.law("item_exact: each item receives its share then unmet demand up to remaining room", () => [],
        (o, e) => all(o.initial.eq(min(e.demand, e.share)), o.afterInitial.eq(e.remaining.minus(o.initial)), o.extra.eq(min(e.remaining, e.demand.minus(e.base))),
          o.budget.eq(e.base.plus(o.extra)), o.remaining.eq(e.remaining.minus(o.extra)))),
    ] },
  ];
};

export const BOUNDS_BUGS: BoundsBug[] = ["allow over cap", "change fitting text", "lose byte accounting", "wrong marker count",
  "refuse an exact cut", "allocate past demand", "allocate past remaining",
  "wrong room", "wrong halves", "wrong loss", "wrong overflow", "wrong sample split", "wrong protected room",
  "accept wrong share", "refuse correct share", "refuse correct halves", "wrong sample halves", "wrong sample earliest",
  "wrong sample latest", "wrong sample omission", "sample over limit", "refuse exact sample", "accept over budget",
  "accept over demand", "lose allocation sum", "refuse valid allocation", "refuse fitting text", "overbook components", "wrong first slot", "wrong last slot", "accept slot outside sample",
  "accept impossible sample", "refuse exact slot"];
