// One bridge job's life, from the call that makes it to its answer. The server hands a job to the
// mod's poll, but the poll's response can be lost on the way (the mod's fetch fails mid-response),
// and the server cannot tell. So the mod confirms a job with a receipt before it runs it, and runs
// it only if the receipt is accepted. A job handed out and never confirmed fails at the receipt
// limit, long before the answer limit, and since the mod never ran it, nothing is repeated: no job
// is ever handed out twice.
//
// Phases: 0 queued, 1 handed to a poll, 2 confirmed (the mod runs it), 3 settled (answered, or
// failed by a limit). Events: the server hands it out, the mod's receipt, the mod's answer, the
// receipt limit, the answer limit. The server steps one machine per job
// (src/kernel/verified/job-receipt.ts) and acts only on an event the machine accepts.
import { all, no, oneOf, rule, when, yes } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type JobReceiptBug =
  | "a second receipt runs the job again"
  | "an answer for an unconfirmed job is taken"
  | "the receipt limit fails a confirmed job"
  | "a settled job is handed out again"
  | "the answer limit leaves the job live";

export const JOB_QUEUED = 0, JOB_HANDED = 1, JOB_CONFIRMED = 2, JOB_SETTLED = 3;

const job = (bug?: JobReceiptBug) => rule("bridge job")
  .inputs({ event: oneOf("hand", "receipt", "answer", "receiptLimit", "answerLimit") })
  .state({ phase: JOB_QUEUED, hands: 0, runs: 0, answers: 0 })
  .flags(({ event, phase }) => ({
    hand: event.is("hand").and(bug === "a settled job is handed out again"
      ? phase.eq(JOB_QUEUED).or(phase.eq(JOB_SETTLED)) : phase.eq(JOB_QUEUED)),
    receipt: event.is("receipt").and(bug === "a second receipt runs the job again"
      ? phase.eq(JOB_HANDED).or(phase.eq(JOB_CONFIRMED)) : phase.eq(JOB_HANDED)),
    answer: event.is("answer").and(bug === "an answer for an unconfirmed job is taken"
      ? phase.eq(JOB_HANDED).or(phase.eq(JOB_CONFIRMED)) : phase.eq(JOB_CONFIRMED)),
    receiptLimit: event.is("receiptLimit").and(bug === "the receipt limit fails a confirmed job"
      ? phase.eq(JOB_HANDED).or(phase.eq(JOB_CONFIRMED)) : phase.eq(JOB_HANDED)),
    answerLimit: event.is("answerLimit").and(bug === "the answer limit leaves the job live" ? no : phase.ne(JOB_SETTLED)),
  }))
  .step(({ phase, hand, receipt, answer, receiptLimit, answerLimit, hands, runs, answers }) => ({
    phase: when(hand, JOB_HANDED, when(receipt, JOB_CONFIRMED,
      when(answer.or(receiptLimit).or(answerLimit), JOB_SETTLED, phase))),
    hands: when(hand, hands.plus(1), hands),
    runs: when(receipt, runs.plus(1), runs),
    answers: when(answer, answers.plus(1), answers),
  }));

export const jobReceiptKernels = (bug?: JobReceiptBug): Kernel[] => {
  const j = job(bug);
  return [{
    id: "bridgeJob",
    rule: j,
    laws: [
      j.law("phase_in_range: a job is queued, handed, confirmed or settled",
        ({ phase }) => all(phase.atLeast(JOB_QUEUED), phase.atMost(JOB_SETTLED))),
      j.law("counts_match_phase: a queued job was never handed, a job not yet confirmed never ran, and only a settled job was answered",
        ({ phase, hands, runs, answers }) => all(
          phase.eq(JOB_QUEUED).implies(all(hands.eq(0), runs.eq(0), answers.eq(0))),
          phase.eq(JOB_HANDED).implies(all(hands.eq(1), runs.eq(0), answers.eq(0))),
          phase.eq(JOB_CONFIRMED).implies(all(hands.eq(1), runs.eq(1), answers.eq(0))))),
      j.law("handed_once: a job is handed to the mod at most once",
        ({ hands }) => hands.atMost(1)),
      j.law("runs_once: the mod runs a job at most once, and only one it was handed",
        ({ runs, hands }) => all(runs.atMost(1), runs.atMost(hands))),
      j.law("answered_only_if_run: a job's answer is taken at most once, and only for a job the mod confirmed",
        ({ answers, runs }) => all(answers.atMost(1), answers.atMost(runs))),
    ],
    stepLaws: [
      j.stepLaw("settled_final: a settled job never moves again",
        (e, after) => e.phase.eq(JOB_SETTLED).implies(all(after.phase.eq(JOB_SETTLED), after.hands.eq(e.hands), after.runs.eq(e.runs), after.answers.eq(e.answers))),
        () => yes),
      j.stepLaw("receipt_runs_handed: the receipt for a handed job is accepted, so the mod runs it",
        (e, after) => all(after.phase.eq(JOB_CONFIRMED), after.runs.eq(e.runs.plus(1))),
        ({ event, phase }) => all(event.is("receipt"), phase.eq(JOB_HANDED))),
      j.stepLaw("unconfirmed_answer_refused: an answer for a job the mod did not confirm is refused",
        (e, after) => e.phase.ne(JOB_CONFIRMED).implies(all(after.answers.eq(e.answers), after.phase.eq(e.phase))),
        ({ event }) => event.is("answer")),
      j.stepLaw("receipt_limit_spares_confirmed: the receipt limit never fails a job the mod is running",
        (e, after) => e.phase.eq(JOB_CONFIRMED).implies(after.phase.eq(JOB_CONFIRMED)),
        ({ event }) => event.is("receiptLimit")),
      j.stepLaw("answer_limit_settles: once its caller gives up, a live job settles, so it can no longer be confirmed or answered",
        (_e, after) => after.phase.eq(JOB_SETTLED),
        ({ event }) => event.is("answerLimit")),
      j.stepLaw("unconfirmed_fails_at_receipt_limit: a handed job with no receipt settles at the receipt limit, never run",
        (e, after) => all(after.phase.eq(JOB_SETTLED), after.runs.eq(e.runs)),
        ({ event, phase }) => all(event.is("receiptLimit"), phase.eq(JOB_HANDED))),
    ],
  }];
};

export const JOB_RECEIPT_BUGS: JobReceiptBug[] = [
  "a second receipt runs the job again",
  "an answer for an unconfirmed job is taken",
  "the receipt limit fails a confirmed job",
  "a settled job is handed out again",
  "the answer limit leaves the job live",
];
