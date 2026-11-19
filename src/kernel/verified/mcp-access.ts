// The access rule every mcp call passes. The rule and its laws live in proofs/mcp-access.ts; this
// folds one call's two facts into the compiled machine, so a pair the session's catalog does not
// hold, and this plugin's own server, never send a job to the mod.
import { mcpAccess } from "./generated/mcp-access.js";

/** What one call's resolution allows: the verdict, and how many jobs it sends. */
export interface McpAccessVerdict {
  /** The call may run. */
  allow: boolean;
  /** Jobs the host sends: exactly 1 when allowed, 0 when refused. */
  jobs: number;
}

const bit = (value: number): boolean => value === 1;

/** One call's verdict, from whether the catalog holds the pair and whether it is our own server. */
export const mcpAccessVerdict = (known: boolean, own: boolean): McpAccessVerdict => {
  const state = mcpAccess.step({}, mcpAccess.init({}), { known: known ? 1 : 0, own: own ? 1 : 0 });
  const scalars = state.scalars;
  return { allow: bit(scalars["out.allowed"] ?? 0), jobs: scalars["out.jobs"] ?? 0 };
};
