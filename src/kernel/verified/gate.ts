// The gate every worker message passes. The rule and its laws live in proofs/gate.ts; this folds
// one message's two facts into the compiled machine, so a message without the run's token, a tool
// call after the done, or a second done is never acted on. src/kernel/execute.ts asks the gate
// once per worker message and does exactly what it says.
import { messageGate } from "./generated/gate.js";

/** Phases the compiled machine reports: 0 open, 1 done admitted, 2 refused. */
const GATE_REFUSED = 2;
/** Message kinds, in the order proofs/gate.ts declares them. */
const KIND_CALL = 0;
const KIND_DONE = 1;

/** What the host may do with one message: act on its tool call, take the done, or nothing. */
export type MessageVerdict = "call" | "done" | "rejected";

/** One run's gate: a fresh machine per run, stepped once per worker message it receives. */
export class MessageGate {
  #state = messageGate.init({});

  /** The verdict for one message: whether it carried this run's token, and whether it is the done. */
  decide(matched: boolean, done: boolean): MessageVerdict {
    const before = this.#state.scalars;
    this.#state = messageGate.step({}, this.#state, { token: matched ? 1 : 0, kind: done ? KIND_DONE : KIND_CALL });
    const after = this.#state.scalars;
    if (after.phase === GATE_REFUSED) return "rejected";
    if (after.dones > before.dones) return "done";
    if (after.calls > before.calls) return "call";
    // A closed gate: the done was already admitted, so this message reaches nothing.
    return "rejected";
  }
}
