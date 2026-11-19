// The access rule every \`mcp.<server>.<tool>()\` call passes before a job reaches the bridge. A
// program may call only a server and tool the session's own catalog holds, and never this
// plugin's own server. Per call the rule reads two facts, whether the catalog holds the pair and
// whether it names our own server, and nothing else:
//
// - an allowed call is one the catalog holds;
// - our own server is never allowed, whatever the catalog holds;
// - a refused call sends no job;
// - an allowed call sends exactly one.
//
// The host folds the resolution into the compiled machine in src/kernel/verified/mcp-access.ts and
// enqueues a bridge job only through its verdict, so a pair the catalog lost, a misspelt name and
// our own fabric_exec cannot reach the mod.
import { all, bool, fun, no, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type McpAccessBug =
  | "a tool outside the catalog is allowed"
  | "the fabric server is allowed"
  | "a refused call still sends a job"
  | "a deny-all rule refuses every call";

/** One call: \`known\` when the catalog holds the pair, \`own\` when it names this plugin's server. */
const access = (bug?: McpAccessBug) => fun("mcp call access")
  .inputs({ known: bool, own: bool })
  .returns(({ known, own }) => {
    const allow = bug === "a tool outside the catalog is allowed" ? own.not()
      : bug === "the fabric server is allowed" ? known
      : bug === "a deny-all rule refuses every call" ? no
      : all(known, own.not());
    const allowed = when(allow, 1, 0);
    return {
      allowed,
      jobs: bug === "a refused call still sends a job" ? 1 : allowed,
    };
  });

export const mcpAccessKernels = (bug?: McpAccessBug): Kernel[] => {
  const a = access(bug);
  // The laws state the decision over the inputs, not one output against another: a rule that
  // refuses everything satisfies output-only laws, but not "exactly when known and not own".
  return [{
    id: "mcpAccess",
    fun: a,
    decisions: [
      a.law("allowed_iff_known: a call is allowed exactly when the catalog holds it and it is not this plugin's server", () => [],
        (o, e) => o.allowed.eq(when(all(e.known, e.own.not()), 1, 0))),
      a.law("jobs_iff_known: an allowed call sends exactly one job and a refused call none", () => [],
        (o, e) => o.jobs.eq(when(all(e.known, e.own.not()), 1, 0))),
    ],
  }];
};

export const MCP_ACCESS_BUGS: McpAccessBug[] = [
  "a tool outside the catalog is allowed",
  "the fabric server is allowed",
  "a refused call still sends a job",
  "a deny-all rule refuses every call",
];
