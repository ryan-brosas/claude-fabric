import { check, transpile } from "./check.ts";
import { tools } from "./tools.ts";

const WORKER = new URL("./worker.ts", import.meta.url).href;
const MAX_RESULT_CHARS = 20_000;

export interface RunResult { ok: boolean; text: string; ms: { check: number; run: number }; calls: number }

export async function run(code: string, cwd: string, options: { payloads?: Record<string, string>; timeoutMs?: number } = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const t0 = performance.now();
  const checked = check(code);
  const checkMs = performance.now() - t0;
  if (!checked.ok) return { ok: false, text: "Type errors; code was not executed:\n" + checked.errors.join("\n"), ms: { check: checkMs, run: 0 }, calls: 0 };
  const impl = tools(cwd);
  const worker = new Worker(WORKER);
  let calls = 0;
  const t1 = performance.now();
  try {
    const done = await new Promise<{ value?: unknown; error?: string; logs: string[] }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      worker.onmessage = async (event) => {
        const msg = event.data;
        if (msg.kind === "done") { clearTimeout(timer); resolve(msg); return; }
        if (msg.kind === "call") {
          calls++;
          const fn = impl[msg.ref];
          try {
            if (!fn) throw new Error(`unknown action ${msg.ref}`);
            worker.postMessage({ kind: "reply", id: msg.id, value: await fn(msg.args) });
          } catch (error) {
            worker.postMessage({ kind: "reply", id: msg.id, error: error instanceof Error ? error.message : String(error) });
          }
        }
      };
      worker.postMessage({ kind: "run", js: transpile(code), payloads: options.payloads ?? {} });
    });
    const body = done.error ? "Error: " + done.error : typeof done.value === "string" ? done.value : JSON.stringify(done.value, null, 2) ?? "undefined";
    let text = [...done.logs, body].join("\n");
    if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + `\n[result cut at ${MAX_RESULT_CHARS} chars]`;
    return { ok: !done.error, text, ms: { check: checkMs, run: performance.now() - t1 }, calls };
  } finally {
    worker.terminate();
  }
}
