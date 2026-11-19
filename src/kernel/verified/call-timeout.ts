// How long one program may run. The rule and its laws live in proofs/call-timeout.ts; this folds
// the call's requested timeout into the compiled machine, so no program runs past 600000 ms and a
// call that sets none keeps the 120000 ms every program had before.
import { callTimeout } from "./generated/call-timeout.js";

/** The run's time limit in ms, from the call's `timeout` (absent: the default). */
export const callTimeoutMs = (requested: number | undefined): number =>
  callTimeout.step({}, callTimeout.init({}), { given: requested === undefined ? 0 : 1, requested: requested ?? 0 }).scalars["out.ms"] ?? 0;
