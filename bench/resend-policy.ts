// The observed pane is outside the machine. Every retry decision uses this same proven rule.
import { bool, fun, nat, when } from "gdp-wired";

type Bug = "no cap" | "ignore pane" | "stop early";
export const resendPolicy = (bug?: Bug) => fun("enter resend")
  .inputs({ count: nat, pending: bool })
  .returns(({ count, pending }) => ({
    resend: when(bug === "no cap" ? pending : bug === "ignore pane" ? count.lt(3)
      : pending.and(count.lt(bug === "stop early" ? 2 : 3)), 1, 0),
  }));

// Laws apply to every decision, not just to a bounded set of examples.
export const resendLaws = (policy: ReturnType<typeof resendPolicy>) => [
  policy.law("capped: at most three resends", () => [],
    (out, input) => out.resend.eq(1).implies(input.count.lt(3))),
  policy.law("observed: resend only while the prompt is pending", () => [],
    (out, input) => out.resend.eq(1).implies(input.pending)),
  policy.law("eligible: a pending prompt below the cap is retried", () => [],
    (out, input) => input.pending.and(input.count.lt(3)).implies(out.resend.eq(1))),
];

const run = resendPolicy().compiled();
export function decideResend(input: { count: number; pending: boolean }): { resend: boolean } {
  return { resend: run(input).resend === 1 };
}
