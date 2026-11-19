// One bridge job's life. The rule and its laws live in proofs/job-receipt.ts: a job is handed to
// the mod at most once, the mod runs it only after the server accepted its receipt, an answer is
// taken only for a job the mod confirmed, and a handed job with no receipt fails at the receipt
// limit, never run. src/kernel/bridge/server.ts steps one machine per job and acts only on an
// event the machine accepts.
import { bridgeJob } from "./generated/job-receipt.js";

/** Events, in the order proofs/job-receipt.ts declares them. */
const EVENTS = { hand: 0, receipt: 1, answer: 2, receiptLimit: 3, answerLimit: 4 } as const;
export type JobEvent = keyof typeof EVENTS;

const SETTLED = 3;

type JobState = ReturnType<typeof bridgeJob.init>;

/** Every live job's machine; a job leaves once it settles. */
export class JobLedger {
  #jobs = new Map<number, JobState>();

  /** A new job, queued. */
  open(id: number): void {
    this.#jobs.set(id, bridgeJob.init({}));
  }

  /** Whether the machine accepts this event for this job; an unknown or settled job accepts none. */
  step(id: number, event: JobEvent): boolean {
    const before = this.#jobs.get(id);
    if (before === undefined) return false;
    const after = bridgeJob.step({}, before, { event: EVENTS[event] });
    const accepted = after.scalars.phase !== before.scalars.phase;
    if (after.scalars.phase === SETTLED) this.#jobs.delete(id);
    else this.#jobs.set(id, after);
    return accepted;
  }

  clear(): void {
    this.#jobs.clear();
  }
}
