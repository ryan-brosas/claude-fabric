// The gate every cut from compact.ts must pass. The rule and its laws live in
// proofs/cut.ts; this folds the facts the producer claims into the compiled
// machine, so a cut that starts mid-exchange, busts its budget without being a
// single prompt-led exchange, keeps a message after one it summarized, or
// summarizes nothing cannot be published.
import { compactionCut } from "./generated/cut.js";

/** Phases the compiled machine reports: 1 open, 2 refused. */
const CUT_OPEN = 1;
const CUT_REFUSED = 2;
/** Ops, in the order proofs/cut.ts declares them. */
const OP_MESSAGE = 0;
const OP_COMMIT = 1;

const isNatural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const bit = (value: boolean): number => (value ? 1 : 0);

export interface CutMessage {
  /** This message is in the kept tail. */
  tail: boolean;
  /** This message is a user prompt with no tool results: a safe tail start. */
  prompt: boolean;
  /** Its size in estimated tokens. */
  bytes: number;
}

export const acceptCut = (budget: number, messages: readonly CutMessage[]): boolean => {
  if (!isNatural(budget) || messages.length === 0) return false;
  for (const message of messages) {
    if (!isNatural(message.bytes) || typeof message.tail !== "boolean" || typeof message.prompt !== "boolean") return false;
  }
  const params = { budget };
  let state = compactionCut.init(params);
  for (const message of messages) {
    state = compactionCut.step(params, state, { op: OP_MESSAGE, tail: bit(message.tail), prompt: bit(message.prompt), bytes: message.bytes });
    if (state.scalars.phase === CUT_REFUSED) return false;
  }
  state = compactionCut.step(params, state, { op: OP_COMMIT, tail: 0, prompt: 0, bytes: 0 });
  return state.scalars.phase === CUT_OPEN;
};
