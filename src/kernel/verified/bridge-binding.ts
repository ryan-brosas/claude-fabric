// The rule a mod passes before it uses a bridge. The rule and its law live in
// proofs/bridge-binding.ts; this folds one read's two facts into the compiled machine.
import { bridgeBinding } from "./generated/bridge-binding.js";

/** Whether a mod may use the secret it read: the file names its own session and holds a secret. */
export const bridgeBindingVerdict = (sameSession: boolean, hasSecret: boolean): boolean => {
  const state = bridgeBinding.step({}, bridgeBinding.init({}), { sameSession: sameSession ? 1 : 0, hasSecret: hasSecret ? 1 : 0 });
  return (state.scalars["out.used"] ?? 0) === 1;
};
