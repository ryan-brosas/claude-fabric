// Copied from pi-fabric (MIT, Tom X Nguyen) src/verified/context.ts at d331f629; dropped user staleness, and the summary allocation now also carries the earlier summary a second compaction re-reads.
// Bridges for proofs/context.ts: what a compaction summary puts in front of
// the model. Production code supplies typed facts; the compiled machines decide.
import { failureLedger as ledgerMachine, summaryCarry as carryMachine } from "./generated/context.js";

const isNatural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const natural = (value: number, what: string): number => {
  if (!isNatural(value)) throw new RangeError(`${what} must be a safe natural, not ${value}`);
  return value;
};

export interface SummaryCarry {
  /** The header, the footer and every separator: reserved before any section content. */
  footerBytes: number;
  /** The newest blocks: the compaction request, the recent directions, the earlier messages. */
  newestBytes: number;
  /** The block a second compaction carries the earlier summary in. */
  carryBytes: number;
  /** Operational history: files, outstanding work, earlier turns, status, transcript. */
  historyBytes: number;
}

/** Reserve the framing, keep the newest blocks whole, then split what they
 * leave between the earlier summary and history: history is guaranteed half of
 * it, and the carry takes the rest up to its own demand. */
export const allocateSummaryCarry = (
  limit: number,
  footer: number,
  newest: number,
  earlier: number,
  history: number,
): SummaryCarry => {
  const input = {
    limit: natural(limit, "limit"),
    footer: natural(footer, "footer"),
    newest: natural(newest, "newest"),
    earlier: natural(earlier, "earlier"),
    history: natural(history, "history"),
  };
  // The two eras the messages cannot re-derive split the older room evenly: the
  // carried earlier summary, and the record of what just happened.
  const room = Math.max(0, input.limit - Math.min(input.footer, input.limit));
  const older = Math.max(0, room - Math.min(input.newest, room));
  const params = { reserve: natural(Math.floor(older / 2), "reserve") };
  const out = carryMachine.step(params, carryMachine.init(params), input).scalars;
  return {
    footerBytes: out["out.footerBytes"]!,
    newestBytes: out["out.newestBytes"]!,
    carryBytes: out["out.carryBytes"]!,
    historyBytes: out["out.historyBytes"]!,
  };
};

export interface FailureFact {
  /** The failure happened after the previous compaction marker. */
  fresh: boolean;
  /** A later exact structural success resolved it. */
  resolved: boolean;
}

export interface FailureLedger {
  /** Parallel to the input: whether each failure is itemized. */
  itemized: boolean[];
  total: number;
  open: number;
  aged: number;
  resolved: number;
}

/** Pass fresh failures newest first, then aged ones newest first, then resolved ones:
 * the newest fresh failures take room first, and aged ones fill only what is left. */
export const foldFailureLedger = (failures: readonly FailureFact[], limit: number): FailureLedger => {
  const params = { limit: natural(limit, "limit") };
  let state = ledgerMachine.init(params);
  const itemized: boolean[] = [];
  for (const failure of failures) {
    const before = state.scalars.itemized!;
    state = ledgerMachine.step(params, state, { fresh: failure.fresh ? 1 : 0, resolved: failure.resolved ? 1 : 0 });
    itemized.push(state.scalars.itemized! > before);
  }
  const { total, open, aged, settled } = state.scalars;
  return { itemized, total: total!, open: open!, aged: aged!, resolved: settled! };
};
