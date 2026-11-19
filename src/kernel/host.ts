import { check } from "./check.ts";
import { execute } from "./execute.ts";
import { MAX_RESULT_CHARS, bound, format } from "./result.ts";
import { TOOLS } from "../providers/tools/index.ts";
import { guestTypes } from "../registry/generate.ts";

// The declarations are constant, so they are printed once and reused by every check.
const DECLARATIONS = guestTypes(TOOLS);

export interface RunResult { ok: boolean; text: string; ms: { check: number; run: number }; calls: number }

export async function run(code: string, cwd: string, options: { payloads?: Record<string, string>; timeoutMs?: number } = {}): Promise<RunResult> {
  const t0 = performance.now();
  const checked = check(code, DECLARATIONS);
  const checkMs = performance.now() - t0;
  if (!checked.ok) return { ok: false, text: "Type errors; code was not executed:\n" + checked.errors.join("\n"), ms: { check: checkMs, run: 0 }, calls: 0 };
  const t1 = performance.now();
  const { done, calls } = await execute(code, cwd, options);
  const text = bound(format(done), MAX_RESULT_CHARS);
  return { ok: !done.error, text, ms: { check: checkMs, run: performance.now() - t1 }, calls };
}
