import { transpile } from "./check.ts";
import { isToolName, type Done, type HostToWorker, type WorkerToHost } from "./protocol.ts";
import { tools } from "./tools.ts";

// One fresh Worker per call; every tool call crosses back to this thread.
const WORKER = new URL("./worker.ts", import.meta.url).href;

export interface Executed { done: Done; calls: number }

export async function execute(
  code: string,
  cwd: string,
  options: { payloads?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Executed> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const impl = tools(cwd);
  const js = transpile(code);
  const worker = new Worker(WORKER);
  let calls = 0;
  try {
    const done = await new Promise<Done>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      worker.onmessage = async (event: MessageEvent<WorkerToHost>) => {
        const msg = event.data;
        if (msg.kind === "done") { clearTimeout(timer); resolve(msg); return; }
        calls++;
        let reply: HostToWorker;
        try {
          if (!isToolName(msg.ref)) throw new Error(`unknown action ${msg.ref}`);
          reply = { kind: "reply", id: msg.id, value: await impl[msg.ref](msg.args) };
        } catch (error) {
          reply = { kind: "reply", id: msg.id, error: error instanceof Error ? error.message : String(error) };
        }
        worker.postMessage(reply);
      };
      // An error that escapes the program (a throw in a timer callback, a worker that fails to load)
      // sends no "done" message. Treat it as the program's error now, so it is formatted and
      // bounded like any other, instead of waiting for the timeout.
      worker.onerror = (event) => {
        clearTimeout(timer);
        const error = event.error instanceof Error ? event.error.message : event.message || "worker failed with no message";
        resolve({ kind: "done", error, logs: [] });
      };
      const start: HostToWorker = { kind: "run", js, payloads: options.payloads ?? {} };
      worker.postMessage(start);
    });
    return { done, calls };
  } finally {
    worker.terminate();
  }
}
