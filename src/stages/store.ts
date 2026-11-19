// Adapted from pi-fabric (MIT, Tom X Nguyen) src/native-codemode.ts at d331f629; the limits and
// the commit rule are the compiled machine in verified/, a store() call stages one key instead of
// a value map, and the texts say store and load.

import { acceptCommit, writeVerdict } from "./verified/store-limits.ts";

/** The most JSON chars one stored value may take. */
export const VALUE_LIMIT = 262_144;
/** The most JSON chars the whole store may take. */
export const TOTAL_LIMIT = 1_048_576;

/** The values a program's store holds, keyed by string. */
export type StoreValues = Readonly<Record<string, unknown>>;

/** A value's JSON text, or undefined when JSON cannot hold it. */
export const jsonText = (value: unknown): string | undefined => JSON.stringify(value);

/** The store's own copy, so no program keeps a handle on what it stored or loaded. */
export const copyValue = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const refusal = (key: string, length: number, total: number): Error =>
  length > VALUE_LIMIT
    ? new Error('store: the value for "' + key + '" is ' + length + " JSON chars, over the limit of " + VALUE_LIMIT)
    : new Error('store: writing "' + key + '" would make the store ' + total + " JSON chars, over the limit of " + TOTAL_LIMIT);

/**
 * The values as the store holds them: JSON copies, each within VALUE_LIMIT and all of them within
 * TOTAL_LIMIT. A value that breaks either limit fails here, naming the key and the limit. The
 * decision is the compiled machine's (verified/store-limits.ts, laws in proofs/store-limits.ts).
 */
export function storable(values: StoreValues): Record<string, unknown> {
  const kept: Record<string, unknown> = Object.create(null);
  let total = 0;
  for (const [key, value] of Object.entries(values)) {
    const text = jsonText(value);
    if (text === undefined) throw new Error('store: the value for "' + key + '" is not JSON');
    const verdict = writeVerdict({ value: text.length, total, valueLimit: VALUE_LIMIT, totalLimit: TOTAL_LIMIT });
    if (!verdict.accept) throw refusal(key, text.length, verdict.next);
    kept[key] = JSON.parse(text);
    total = verdict.store;
  }
  return kept;
}

/**
 * The store after one store() call, or the reason it is refused: the new value goes under the key,
 * and undefined removes the key. The store passed in is left alone.
 */
export function write(values: StoreValues, key: string, value: unknown): Record<string, unknown> {
  const next: Record<string, unknown> = Object.assign(Object.create(null), values);
  if (value === undefined) delete next[key];
  else next[key] = value;
  return storable(next);
}

/** Whether a run's staged writes are committed: only when the whole program succeeded. */
export const commitAllowed = (success: boolean, written: boolean): boolean => acceptCommit(success, written);
