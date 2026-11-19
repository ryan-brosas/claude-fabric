import { BUILTIN_TOOLS, isBuiltinTool } from "../bridge/contract.ts";
import { builtinAccessVerdict } from "./verified/builtin-access.ts";

// One program's call to a built-in tool Claude Code owns. The tool runs in Claude Code, not in this
// server: the host asks the access rule first, then sends one job over the socket, and the mod runs
// it with `$.tool.call`. The list of tools this can happen for is fixed in `bridge/contract.ts`
// (`BUILTIN_TOOLS`), because `$.tool.call` skips the person's permission prompts and deny rules:
// a program may reach the one tool the user allowed through it, and nothing else.

/** What a run needs from the server process to reach Claude Code's built-in tools. */
export interface BuiltinLink {
  /** One job to the mod, resolving what `$.tool.call` gave it: `{ result, text }`. */
  tool(name: string, input: Record<string, unknown>): Promise<unknown>;
  /** Why no built-in tool can run at all, when the bridge did not start. */
  error?: string;
}

/** The link a built-in tool's `run` gets: the access check and the job, in one call. */
export interface BuiltinToolLink {
  call(tool: string, input: Record<string, unknown>): Promise<unknown>;
}

/**
 * One call: the access rule (proofs/builtin-access.ts) decides whether a job leaves, then the
 * bridge carries it. A job leaves only through the compiled machine's verdict, so a tool the
 * allowlist does not hold never reaches the mod.
 */
export async function callBuiltin(
  link: BuiltinLink,
  tool: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const verdict = builtinAccessVerdict(isBuiltinTool(tool));
  if (verdict.jobs !== 1) {
    throw new Error(tool + ": a program may not call " + JSON.stringify(tool) +
      " through the Fabric mod; it may call only " + BUILTIN_TOOLS.join(", ") + ".");
  }
  if (link.error !== undefined) throw new Error(tool + ": " + link.error);
  return link.tool(tool, input);
}

/** The link a provider's run receives, or none when this run has no bridge to the mod. */
export const builtinTools = (link: BuiltinLink | undefined): BuiltinToolLink | undefined =>
  (link === undefined ? undefined : { call: (tool, input) => callBuiltin(link, tool, input) });
