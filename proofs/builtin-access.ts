// The access rule every built-in tool call passes before a job reaches the bridge. A program may
// call only a tool the host's fixed allowlist holds, and the list holds only WebSearch because
// `$.tool.call` skips the person's permission prompts and deny rules. Per call the rule reads one
// fact, whether the allowlist holds the tool, and nothing else:
//
// - an allowed call is one the allowlist holds;
// - a refused call sends no job;
// - an allowed call sends exactly one.
//
// The host folds the fact into the compiled machine in src/kernel/verified/builtin-access.ts and
// enqueues a bridge job only through its verdict, so a tool the list does not hold cannot reach
// the mod. The mod checks the same list again before it runs a job (`BUILTIN_TOOLS` in
// src/bridge/contract.ts), so a host bug is not a second way in.
import { bool, fun, no, when, yes } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type BuiltinAccessBug =
  | "every tool is allowlisted"
  | "a refused tool still sends a job"
  | "a deny-all rule refuses every tool";

/** One call: `allowlisted` when the host's fixed list holds the tool a program named. */
const access = (bug?: BuiltinAccessBug) => fun("built-in tool access")
  .inputs({ allowlisted: bool })
  .returns(({ allowlisted }) => {
    const allow = bug === "every tool is allowlisted" ? yes
      : bug === "a deny-all rule refuses every tool" ? no
      : allowlisted;
    const allowed = when(allow, 1, 0);
    return {
      allowed,
      jobs: bug === "a refused tool still sends a job" ? 1 : allowed,
    };
  });

export const builtinAccessKernels = (bug?: BuiltinAccessBug): Kernel[] => {
  const a = access(bug);
  // The laws state the decision over the input, not one output against another: a rule that
  // refuses everything satisfies output-only laws, but not "exactly when the allowlist holds it".
  return [{
    id: "builtinAccess",
    fun: a,
    decisions: [
      a.law("allowed_iff_allowlisted: a built-in tool is allowed exactly when the fixed allowlist holds it", () => [],
        (o, e) => o.allowed.eq(when(e.allowlisted, 1, 0))),
      a.law("jobs_iff_allowlisted: an allowed tool sends exactly one job and a refused one none", () => [],
        (o, e) => o.jobs.eq(when(e.allowlisted, 1, 0))),
    ],
  }];
};

export const BUILTIN_ACCESS_BUGS: BuiltinAccessBug[] = [
  "every tool is allowlisted",
  "a refused tool still sends a job",
  "a deny-all rule refuses every tool",
];
