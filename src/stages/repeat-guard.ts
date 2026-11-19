// Adapted from pi-fabric (MIT, Tom X Nguyen) src/repeat-guard.ts at d331f629; the counting rule is
// the pure next(), which counts through the compiled machine in verified/, the class only wraps it,
// the fingerprint is a stable string instead of a SHA-256, and the texts say fabric_exec.

import { countRepeat } from "./verified/repeat-guard.ts";

/**
 * Degenerate-loop breaker for fabric_exec. Identical calls back-to-back are how a model burns a
 * session: ten rounds of the same read add nothing after the first. The fingerprint is the program
 * plus its payload values, so a short wrapper that carries its work in payloads still counts as
 * different calls. Any differing fingerprint resets the count.
 */
export const WARN = 3;
export const BLOCK = 6;

/** What the guard remembers between calls: the last fingerprint and how often it repeated. */
export interface RepeatState {
  fingerprint: string | undefined;
  count: number;
}

export const INITIAL_STATE: RepeatState = { fingerprint: undefined, count: 0 };

export interface RepeatVerdict {
  state: RepeatState;
  /** The result should carry a warning line. */
  warn: boolean;
  /** Nothing may run. */
  blocked: boolean;
}

/** Object keys sort recursively, so key order is cosmetic and absent and empty payloads agree. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return "{" + entries.map(([key, nested]) => JSON.stringify(key) + ":" + stable(nested)).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

/** The identity of one call: its program and its payload values. */
export const fingerprint = (code: string, payloads?: Readonly<Record<string, string>>): string =>
  stable([code, payloads ?? {}]);

/**
 * The decision for one call, given the fingerprint of its program and payloads. Consecutive means
 * the same fingerprint as the call before it; anything else starts the count again. The count and
 * both verdicts come from the compiled machine (src/stages/verified/repeat-guard.ts), whose laws
 * are in proofs/repeat-guard.ts.
 */
export function next(state: RepeatState, current: string, warnAt = WARN, blockAt = BLOCK): RepeatVerdict {
  const counted = countRepeat(state.count, current === state.fingerprint, warnAt, blockAt);
  return {
    state: { fingerprint: current, count: counted.count },
    warn: counted.warned,
    blocked: counted.blocked,
  };
}

export const warnText = (count: number, blockAt = BLOCK): string =>
  "[circuit-breaker] identical fabric_exec code has now run " + count + " times in a row; at " + blockAt + " identical runs will be blocked. Change the approach or finish your turn.";

export const blockText = (count: number): string =>
  "Circuit breaker: this exact fabric_exec code has now executed " + count + " times in a row and was blocked. Re-running identical code adds no information. Summarize what you already know and finish your turn; if the call is genuinely required, change the code materially.";

/** One guard per server process, which is one session. */
export class RepeatGuard {
  #state: RepeatState = INITIAL_STATE;

  constructor(
    /** Consecutive identical calls that start producing a warning. */
    readonly warnAt: number = WARN,
    /** Consecutive identical calls that are blocked outright. */
    readonly blockAt: number = BLOCK,
  ) {}

  observe(code: string, payloads?: Readonly<Record<string, string>>): RepeatVerdict {
    const verdict = next(this.#state, fingerprint(code, payloads), this.warnAt, this.blockAt);
    this.#state = verdict.state;
    return verdict;
  }
}
