import type { BuiltinLink } from "./builtin.ts";
import { check } from "./check.ts";
import { execute } from "./execute.ts";
import type { McpLink } from "./mcp.ts";
import { MAX_RESULT_CHARS, bound, format } from "./result.ts";
import type { Done } from "./protocol.ts";
import { commitPlan, type Store } from "./store.ts";
import { STORE } from "../providers/store/index.ts";
import { HISTORY } from "../providers/tools/history.ts";
import { TOOLS } from "../providers/tools/index.ts";
import { guestTypes, inputFields, namespaceTypes } from "../registry/generate.ts";
import { mcpTypes } from "../registry/mcp.ts";
import { repairCode } from "../stages/code-repair.ts";
import { outputBudget } from "../stages/output-budget.ts";
import { BLOCK, type RepeatGuard, blockText, warnText } from "../stages/repeat-guard.ts";
import { typeErrorGuidance, type GuidanceTool } from "../stages/type-guidance.ts";

// What a failed check's hints may name: the one tool list, with each tool's real fields.
const GUIDANCE_TOOLS: GuidanceTool[] = TOOLS.map((action) => ({ name: action.name, fields: inputFields(action) }));

const TYPE_ERRORS = "Type errors; code was not executed:";

export interface RunOptions {
  payloads?: Record<string, string>;
  timeoutMs?: number;
  /** The session's guard: one per server process. Without it, repeats are not counted. */
  guard?: RepeatGuard;
  /** The session's store: one per server process. Without it, a run's writes are dropped. */
  store?: Store;
  /** The session's MCP link: the catalog the check prints from and the socket a call crosses. */
  mcp?: McpLink;
  /** The session's bridge to Claude Code's built-in tools: the socket a WebSearch crosses. */
  builtin?: BuiltinLink;
  /** The mod-published path, read when a history call reaches the host. */
  transcriptPath?: () => string | undefined;
}

export interface RunResult { ok: boolean; text: string; ms: { check: number; run: number }; calls: number }

// Every text that reaches the model passes the one cap.
const budget = (text: string): Promise<string> => outputBudget({ text, max: MAX_RESULT_CHARS, fallback: bound });

/** Check and, on failure, try a repair without starting a worker or calling tools. */
export function checkProgram(code: string, options: Pick<RunOptions, "mcp"> = {}) {
  // The tool declarations are constant, but the mcp surface is not: it is printed from the
  // session's catalog, which the mod may send again while the server runs.
  const declarations = guestTypes(TOOLS, STORE, [mcpTypes(options.mcp?.catalog() ?? { servers: [] }), namespaceTypes("history", HISTORY)]);
  // The program the model sent is graded first: repair is for a program the check rejected. Some
  // valid programs look exactly like an unquoted path (Read(/a.txt/.source) reads a regex's source
  // string), so rewriting them unasked would change what the program does. The repaired text is
  // used only when it passes where the original did not.
  let program = code;
  let checked = check(code, declarations);
  if (!checked.ok) {
    const repaired = repairCode(code, checked.indexTargets);
    if (repaired !== code) {
      const retried = check(repaired, declarations);
      if (retried.ok) {
        program = repaired;
        checked = retried;
      }
    }
  }
  return { program, checked };
}

export async function run(code: string, cwd: string, options: RunOptions = {}): Promise<RunResult> {
  const t0 = performance.now();
  const { program, checked } = checkProgram(code, options);
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
  const { done: ran, calls } = await execute(program, cwd, options);
  // The warning goes last, before the cap: the middle cut keeps the tail, so it survives,
  // and every result stays within MAX_RESULT_CHARS.
  const warning = repeat?.warn ? "\n" + warnText(repeat.state.count, BLOCK) : "";
  const render = (done: Done): Promise<string> => budget(format(done) + warning);
  const ms = { check: checkMs, run: performance.now() - t1 };
  // Format first: a result the formatter cannot render (a BigInt, say) must commit nothing.
  let text: string;
  try {
    text = await render(ran);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, text: await budget("Error: the result could not be formatted: " + message), ms, calls };
  }
  // Commit last, and only the keys this run wrote, re-checked against the store as it is now: a
  // commit the current store refuses fails this call and writes nothing.
  const delta = commitPlan(ran, options.store);
  if (delta !== undefined) {
    try {
      options.store!.commit(delta);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed: Done = { ...ran, ok: false, value: undefined, error: message, writes: { set: {}, remove: [] } };
      return { ok: false, text: await render(failed), ms, calls };
    }
  }
  return { ok: ran.ok, text, ms, calls };
}
