// How long one fabric_exec program may run. The call may set `timeout` in ms, as Claude Code's Bash
// does, up to Bash's own foreground limit:
//
// - no timeout given: 120000 ms, the limit every program had before;
// - a timeout within the limit: exactly that many ms;
// - a timeout over the limit: the limit, 600000 ms, never more.
//
// The server folds the requested value into the compiled machine in
// src/kernel/verified/call-timeout.ts and starts the run with its answer.
import { bool, fun, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export const DEFAULT_CALL_MS = 120_000;
export const MAX_CALL_MS = 600_000;

export type CallTimeoutBug =
  | "a timeout over the limit is kept"
  | "no timeout runs without a limit"
  | "a timeout within the limit is replaced by the default";

const callTimeout = (bug?: CallTimeoutBug) => fun("fabric_exec time limit")
  .inputs({ given: bool, requested: nat })
  .returns(({ given, requested }) => {
    const capped = bug === "a timeout over the limit is kept" ? requested : when(requested.gt(MAX_CALL_MS), MAX_CALL_MS, requested);
    const asked = bug === "a timeout within the limit is replaced by the default" ? DEFAULT_CALL_MS : capped;
    return { ms: when(given, asked, bug === "no timeout runs without a limit" ? 0 : DEFAULT_CALL_MS) };
  });

export const callTimeoutKernels = (bug?: CallTimeoutBug): Kernel[] => {
  const c = callTimeout(bug);
  return [{
    id: "callTimeout",
    fun: c,
    decisions: [
      c.law("default_when_absent: a call that sets no timeout runs for 120000 ms", () => [],
        (o, e) => e.given.not().implies(o.ms.eq(DEFAULT_CALL_MS))),
      c.law("never_over_limit: no call runs for more than 600000 ms", () => [],
        (o) => o.ms.atMost(MAX_CALL_MS)),
      c.law("requested_kept: a timeout within the limit is used exactly", () => [],
        (o, e) => e.given.and(e.requested.atMost(MAX_CALL_MS)).implies(o.ms.eq(e.requested))),
      c.law("over_limit_capped: a timeout over the limit runs for exactly the limit", () => [],
        (o, e) => e.given.and(e.requested.gt(MAX_CALL_MS)).implies(o.ms.eq(MAX_CALL_MS))),
    ],
  }];
};

export const CALL_TIMEOUT_BUGS: CallTimeoutBug[] = [
  "a timeout over the limit is kept",
  "no timeout runs without a limit",
  "a timeout within the limit is replaced by the default",
];
