import { recall } from "./generated/recall.js";

export interface Facts {
  present?: boolean; same?: boolean; limit?: number; entries?: number; chars?: number;
  context?: number; range?: number; responseChars?: number; pageChars?: number;
  named?: boolean; eligible?: boolean; ordered?: boolean; onChain?: boolean;
}
/** Binding, entry eligibility and budget decisions pass the machine compiled from proofs/recall.ts. */
export function decide(facts: Facts) {
  for (const value of [facts.limit, facts.entries, facts.chars, facts.context, facts.range, facts.responseChars, facts.pageChars]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError("history: sizes must be non-negative safe integers");
  }
  const state = recall.step({}, recall.init({}), {
    present: facts.present ? 1 : 0, same: facts.same ? 1 : 0,
    named: facts.named ? 1 : 0, eligible: facts.eligible ? 1 : 0,
    ordered: facts.ordered ? 1 : 0, onChain: facts.onChain ? 1 : 0,
    limitGiven: facts.limit === undefined ? 0 : 1, limit: facts.limit ?? 0,
    entriesGiven: facts.entries === undefined ? 0 : 1, entries: facts.entries ?? 0,
    charsGiven: facts.chars === undefined ? 0 : 1, chars: facts.chars ?? 0,
    context: facts.context ?? 0, range: facts.range ?? 0,
    responseChars: facts.responseChars ?? 0, pageChars: facts.pageChars ?? 0,
  }).scalars;
  return { bound: state["out.bound"] === 1, entryOK: state["out.entryOK"] === 1, limit: state["out.limit"], entries: state["out.entries"],
    chars: state["out.chars"], context: state["out.context"], rangeOK: state["out.rangeOK"] === 1,
    responseOK: state["out.responseOK"] === 1, pageOK: state["out.pageOK"] === 1 };
}
