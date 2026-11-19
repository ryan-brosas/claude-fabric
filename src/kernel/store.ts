import { commitAllowed, storable } from "../stages/store.ts";
import type { Done, StoreDelta } from "./protocol.ts";

/** Whether a run staged anything: any key it set or removed. */
export const stagedWrites = (writes: StoreDelta): boolean =>
  Object.keys(writes.set).length > 0 || writes.remove.length > 0;

/**
 * The session's store: one per server process, which is one Claude Code session, in memory only.
 * A run gets a snapshot and stages its own writes; the host commits only the keys that run wrote,
 * and only when the whole program succeeded. Nothing is written to disk in this slice, so the
 * store dies with the session.
 */
export class Store {
  #values: Record<string, unknown> = Object.create(null);

  /** The values a run starts from, as a copy, so a program never aliases them. */
  snapshot(): Record<string, unknown> {
    return structuredClone(this.#values);
  }

  /**
   * Apply one run's delta to the store as it is now. Only the keys this run wrote move, so two
   * overlapping runs cannot drop each other's keys, and every limit is checked again against the
   * current values: a commit that would break one throws and leaves the store untouched.
   */
  commit(writes: StoreDelta): void {
    const next: Record<string, unknown> = Object.assign(Object.create(null), this.#values);
    for (const key of writes.remove) delete next[key];
    for (const [key, value] of Object.entries(writes.set)) next[key] = value;
    this.#values = storable(next);
  }
}

/** The delta a finished run may commit, or undefined when the store or the commit rule says no. */
export function commitPlan(done: Done, store?: Store): StoreDelta | undefined {
  if (store === undefined) return undefined;
  return commitAllowed(done.ok, stagedWrites(done.writes)) ? done.writes : undefined;
}
