// The gate every worker message passes before the host acts on it. A program shares the worker's
// message channel (it can import node:worker_threads), so the host cannot know a message came from
// the kernel just because it arrived. Per message the gate reads two facts, whether the message
// carries this run's token and whether it is a tool call or the done, and nothing else:
//
// - a message without the run's token is never acted on;
// - no tool call is acted on after an admitted done;
// - at most one done is admitted;
// - a rejected message fails the run, so nothing commits.
//
// Phases: 0 open, 1 done admitted, 2 refused. A refused gate stays refused; a done closes the gate,
// and a message after it is acted on by neither. The host steps this machine once per worker
// message (src/kernel/verified/gate.ts) and does exactly what the phase says.
import { all, bool, oneOf, rule, when, yes } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type GateBug =
  | "a message without the run's token is acted on"
  | "a tool call after the done is acted on"
  | "a second done is admitted";

/** Phases: 0 open, 1 done admitted, 2 refused. */
export const GATE_OPEN = 0, GATE_DONE = 1, GATE_REFUSED = 2;

/** Whether this message may be acted on: trusted, and arriving while the gate is still open. */
const gate = (bug?: GateBug) => rule("message gate")
  .inputs({ token: bool, kind: oneOf("call", "done") })
  .state({ phase: GATE_OPEN, calls: 0, dones: 0, commits: 0 })
  .flags(({ token, kind, phase }) => ({
    live: bug === "a message without the run's token is acted on" ? phase.eq(GATE_OPEN)
      : bug === "a tool call after the done is acted on" ? token.and(phase.eq(GATE_OPEN).or(phase.eq(GATE_DONE).and(kind.is("call"))))
      : bug === "a second done is admitted" ? token.and(phase.eq(GATE_OPEN).or(phase.eq(GATE_DONE).and(kind.is("done"))))
      : token.and(phase.eq(GATE_OPEN)),
  }))
  .step(({ kind, phase, live, calls, dones, commits }) => ({
    // Only an open gate moves: a done closes it, a message it cannot act on refuses it.
    phase: when(phase.ne(GATE_OPEN), phase,
      when(live.and(kind.is("done")), GATE_DONE, when(live, GATE_OPEN, GATE_REFUSED))),
    calls: when(live.and(kind.is("call")), calls.plus(1), calls),
    dones: when(live.and(kind.is("done")), dones.plus(1), dones),
    // The host commits a run's staged writes only through an admitted done.
    commits: when(live.and(kind.is("done")), 1, commits),
  }));

export const gateKernels = (bug?: GateBug): Kernel[] => {
  const g = gate(bug);
  return [{
    id: "messageGate",
    rule: g,
    laws: [
      g.law("one_done: at most one done is admitted, and it is the only commit",
        ({ dones, commits }) => all(dones.atMost(1), commits.atMost(1))),
      g.law("open_uncommitted: an open gate has admitted no done and committed nothing",
        ({ phase, dones, commits }) => phase.eq(GATE_OPEN).implies(all(dones.eq(0), commits.eq(0)))),
      g.law("refused_commits_nothing: a refused run commits nothing",
        ({ phase, commits }) => phase.eq(GATE_REFUSED).implies(commits.eq(0))),
    ],
    stepLaws: [
      g.stepLaw("token_required: a message without the run's token is never acted on",
        (e, after) => all(after.calls.eq(e.calls), after.dones.eq(e.dones), after.commits.eq(e.commits)),
        ({ token }) => token.not()),
      g.stepLaw("no_call_after_done: no tool call is acted on after an admitted done",
        (e, after) => e.phase.eq(GATE_DONE).implies(all(after.calls.eq(e.calls), after.commits.eq(e.commits))),
        ({ kind }) => kind.is("call")),
      g.stepLaw("done_admitted_once: a second done is never admitted",
        (e, after) => e.phase.eq(GATE_DONE).implies(all(after.dones.eq(e.dones), after.commits.eq(e.commits))),
        ({ kind }) => kind.is("done")),
      g.stepLaw("refusal_final: a refused gate stays refused, and the message that refused it is the last one acted on",
        (e, after) => e.phase.eq(GATE_REFUSED).implies(all(
          after.phase.eq(GATE_REFUSED),
          after.calls.eq(e.calls),
          after.dones.eq(e.dones),
          after.commits.eq(e.commits))),
        () => yes),
      g.stepLaw("trusted_call_acts: while open, a trusted tool call is acted on and the gate stays open",
        (e, after) => all(after.calls.eq(e.calls.plus(1)), after.phase.eq(GATE_OPEN), after.commits.eq(e.commits)),
        ({ token, kind, phase }) => all(token, kind.is("call"), phase.eq(GATE_OPEN))),
      g.stepLaw("trusted_done_commits: while open, a trusted done is admitted and it commits",
        (e, after) => all(after.dones.eq(e.dones.plus(1)), after.phase.eq(GATE_DONE), after.commits.eq(1)),
        ({ token, kind, phase }) => all(token, kind.is("done"), phase.eq(GATE_OPEN))),
    ],
  }];
};

export const GATE_BUGS: GateBug[] = [
  "a message without the run's token is acted on",
  "a tool call after the done is acted on",
  "a second done is admitted",
];
