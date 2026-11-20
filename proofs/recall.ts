// The recall boundary sees whether the bound prefix still exists and its SHA-256 matches, and
// the sizes selected or produced by the host. The host hashes bytes and checks expansion slices;
// this machine decides whether the resulting binding and budgets are admissible.
import { bool, fun, min, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type RecallBug = "accept a rewrite" | "limit over cap" | "page over char cap" | "context over cap" | "range over cap";

const recall = (bug?: RecallBug) => fun("recall binding and limits")
  .inputs({ present: bool, same: bool, limitGiven: bool, limit: nat, entriesGiven: bool, entries: nat,
    charsGiven: bool, chars: nat, context: nat, range: nat, responseChars: nat, pageChars: nat })
  .returns(({ present, same, limitGiven, limit, entriesGiven, entries, charsGiven, chars, context, range, responseChars, pageChars }) => ({
    bound: when(bug === "accept a rewrite" ? present : present.and(same), 1, 0),
    limit: when(limitGiven, bug === "limit over cap" ? limit : min(limit, 50), 10),
    entries: when(entriesGiven, min(entries, 20), 10),
    chars: when(charsGiven, min(chars, 24000), 20000),
    context: bug === "context over cap" ? context : min(context, 20),
    rangeOK: when(range.atMost(bug === "range over cap" ? 21 : 20), 1, 0),
    responseOK: when(responseChars.atMost(30000), 1, 0),
    pageOK: when(pageChars.atMost(bug === "page over char cap" ? 24001 : 24000), 1, 0),
  }));

export const recallKernels = (bug?: RecallBug): Kernel[] => {
  const r = recall(bug);
  return [{ id: "recall", fun: r, decisions: [
    r.law("binding_exact: expansion accepts exactly an existing matching prefix", () => [],
      (o, e) => o.bound.eq(1).iff(e.present.and(e.same))),
    r.law("limit_capped: recall returns at most fifty hits", () => [], (o) => o.limit.atMost(50)),
    r.law("limit_default: recall defaults to ten hits", () => [], (o, e) => e.limitGiven.not().implies(o.limit.eq(10))),
    r.law("entries_capped: an expansion page holds at most twenty entries", () => [], (o) => o.entries.atMost(20)),
    r.law("entries_default: an expansion page defaults to ten entries", () => [], (o, e) => e.entriesGiven.not().implies(o.entries.eq(10))),
    r.law("chars_capped: the expansion text budget never exceeds 24000", () => [], (o) => o.chars.atMost(24000)),
    r.law("chars_default: expansion defaults to 20000 characters", () => [], (o, e) => e.charsGiven.not().implies(o.chars.eq(20000))),
    r.law("context_capped: context on either side is at most twenty", () => [], (o) => o.context.atMost(20)),
    r.law("range_refused: an exact range over twenty entries is refused", () => [], (o, e) => e.range.gt(20).implies(o.rangeOK.eq(0))),
    r.law("response_capped: an accepted recall response has at most 30000 characters", () => [], (o, e) => o.responseOK.eq(1).implies(e.responseChars.atMost(30000))),
    r.law("page_capped: an accepted expansion page has at most 24000 text characters", () => [], (o, e) => o.pageOK.eq(1).implies(e.pageChars.atMost(24000))),
  ] }];
};

export const RECALL_BUGS: RecallBug[] = ["accept a rewrite", "limit over cap", "page over char cap", "context over cap", "range over cap"];
