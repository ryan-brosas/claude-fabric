// The gate every store write and every store commit passes. The rule and its laws live in
// proofs/store-limits.ts; this folds the real lengths into the compiled machines, so a value over
// its limit, a store over its limit, or a commit a failed program staged cannot reach the store.
import { storeCommit, storeWrite } from "./generated/store-limits.js";

/** What one write would do: the value's JSON length, and the store's length without its key. */
export interface StoreWriteFacts {
  /** The JSON text length of the value about to be stored; 0 for a removed key. */
  value: number;
  /** The JSON text length of the store without the key this write replaces. */
  total: number;
  /** The most JSON chars one value may take. */
  valueLimit: number;
  /** The most JSON chars the whole store may take. */
  totalLimit: number;
}

/** What the machine decides for one write. */
export interface StoreWriteVerdict {
  /** The write may be stored; a refused write changes nothing. */
  accept: boolean;
  /** The store's length with the value. */
  next: number;
  /** The store's length after the write: next when accepted, the old total when refused. */
  store: number;
}

const bit = (value: number): boolean => value === 1;

/** One write's verdict, from the lengths the stage built. */
export const writeVerdict = (facts: StoreWriteFacts): StoreWriteVerdict => {
  const state = storeWrite.step({}, storeWrite.init({}), {
    value: facts.value,
    total: facts.total,
    valueLimit: facts.valueLimit,
    totalLimit: facts.totalLimit,
  });
  const scalars = state.scalars;
  return { accept: bit(scalars["out.accept"]), next: scalars["out.next"], store: scalars["out.store"] };
};

/** Whether the host commits a run's staged writes: only a successful run that staged some. */
export const acceptCommit = (success: boolean, written: boolean): boolean =>
  bit(storeCommit.step({}, storeCommit.init({}), { success: success ? 1 : 0, written: written ? 1 : 0 }).scalars["out.committed"]);
