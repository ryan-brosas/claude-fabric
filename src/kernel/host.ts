import { check } from "./check.ts";
import { execute } from "./execute.ts";
import { MAX_RESULT_CHARS, bound, format } from "./result.ts";
import { TOOLS } from "../providers/tools/index.ts";
import { guestTypes, inputFields } from "../registry/generate.ts";
import { repairCode } from "../stages/code-repair.ts";
import { outputBudget } from "../stages/output-budget.ts";
import { BLOCK, type RepeatGuard, blockText, warnText } from "../stages/repeat-guard.ts";
import { typeErrorGuidance, type GuidanceTool } from "../stages/type-guidance.ts";

// The declarations are constant, so they are printed once and reused by every check.
const DECLARATIONS = guestTypes(TOOLS);
// What a failed check's hints may name: the one tool list, with each tool's real fields.
const GUIDANCE_TOOLS: GuidanceTool[] = TOOLS.map((action) => ({ name: action.name, fields: inputFields(action) }));

const TYPE_ERRORS = "Type errors; code was not executed:";

export interface RunOptions {
  payloads?: Record<string, string>;
  timeoutMs?: number;
  /** The session's guard: one per server process. Without it, repeats are not counted. */
  guard?: RepeatGuard;
}

export interface RunResult { ok: boolean; text: string; ms: { check: number; run: number }; calls: number }

// Every text that reaches the model passes the one cap.
const budget = (text: string): Promise<string> => outputBudget({ text, max: MAX_RESULT_CHARS, fallback: bound });

export async function run(code: string, cwd: string, options: RunOptions = {}): Promise<RunResult> {
  const t0 = performance.now();
  // The program the model sent is graded first: repair is for a program the check rejected. Some
  // valid programs look exactly like an unquoted path (Read(/a.txt/.source) reads a regex's source
  // string), so rewriting them unasked would change what the program does. The repaired text is
  // used only when it passes where the original did not.
  let program = code;
  let checked = check(code, DECLARATIONS);
  if (!checked.ok) {
    const repaired = repairCode(code);
    if (repaired !== code) {
      const retried = check(repaired, DECLARATIONS);
      if (retried.ok) {
        program = repaired;
        checked = retried;
      }
    }
  }
  const checkMs = performance.now() - t0;
  if (!checked.ok) {
    // The errors are the ones for the code the model sent, so the line numbers match it.
    const hints = typeErrorGuidance(code, checked.errors, GUIDANCE_TOOLS);
    return { ok: false, text: await budget([TYPE_ERRORS, ...checked.errors, ...hints].join("\n")), ms: { check: checkMs, run: 0 }, calls: 0 };
  }
  const repeat = options.guard?.observe(program, options.payloads);
  if (repeat?.blocked) {
    return { ok: false, text: blockText(repeat.state.count), ms: { check: checkMs, run: 0 }, calls: 0 };
  }
  const t1 = performance.now();
  const { done, calls } = await execute(program, cwd, options);
  // The warning goes last, before the cap: the middle cut keeps the tail, so it survives,
  // and every result stays within MAX_RESULT_CHARS.
  const formatted = format(done);
  const text = await budget(repeat?.warn ? formatted + "\n" + warnText(repeat.state.count, BLOCK) : formatted);
  return { ok: !done.error, text, ms: { check: checkMs, run: performance.now() - t1 }, calls };
}
