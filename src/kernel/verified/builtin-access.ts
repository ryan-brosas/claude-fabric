// The access rule every built-in tool call passes. The rule and its laws live in
// proofs/builtin-access.ts; this folds one call's one fact into the compiled machine, so a tool the
// fixed allowlist does not hold never sends a job to the mod.
import { builtinAccess } from "./generated/builtin-access.js";

/** What one call's tool allows: the verdict, and how many jobs it sends. */
export interface BuiltinAccessVerdict {
  /** The call may run. */
  allow: boolean;
  /** Jobs the host sends: exactly 1 when allowed, 0 when refused. */
  jobs: number;
}

/** One call's verdict, from whether the host's allowlist holds the tool. */
export const builtinAccessVerdict = (allowlisted: boolean): BuiltinAccessVerdict => {
  const state = builtinAccess.step({}, builtinAccess.init({}), { allowlisted: allowlisted ? 1 : 0 });
  const scalars = state.scalars;
  return { allow: (scalars["out.allowed"] ?? 0) === 1, jobs: scalars["out.jobs"] ?? 0 };
};
