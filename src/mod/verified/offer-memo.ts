// fabricOnly's answer per loop and tool. The rule and its laws live in proofs/offer-memo.ts: the
// first ask fixes the answer to the visibility verdict, and every later ask gets the same answer.
import { offerMemo } from "./generated/offer-memo.js";

const OFFERED = 1;

type MemoState = ReturnType<typeof offerMemo.init>;

/** One session's answers, one compiled machine per loop and tool. */
export class OfferMemo {
  #machines = new Map<string, MemoState>();

  /** The answer for this ask; `verdict` counts only at a key's first ask. */
  ask(key: string, verdict: () => boolean): boolean {
    const before = this.#machines.get(key) ?? offerMemo.init({});
    // The verdict is asked for only while the key is unanswered: a later ask cannot change it anyway.
    const after = offerMemo.step({}, before, { verdict: (before.scalars.fixed ?? 0) === 0 && verdict() ? 1 : 0 });
    this.#machines.set(key, after);
    return after.scalars.fixed === OFFERED;
  }

  /** A new session: /clear and a resume keep the process under a new session id. */
  clear(): void {
    this.#machines.clear();
  }
}
