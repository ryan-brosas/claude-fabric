import { builtinTools, type BuiltinLink } from "./builtin.ts";
import { transpile } from "./check.ts";
import { callMcp, type McpLink } from "./mcp.ts";
import { MCP_REF, type Done, type HostToWorker, type WorkerToHost } from "./protocol.ts";
import { TOOLS } from "../providers/tools/index.ts";
import { HISTORY } from "../providers/tools/history.ts";
import type { AnyAction } from "../registry/action.ts";
import { parseArgs } from "../registry/generate.ts";
import type { Store } from "./store.ts";
import { MessageGate } from "./verified/gate.ts";

// One fresh Worker per call; every tool call crosses back to this thread.
const WORKER = new URL("./worker.ts", import.meta.url).href;
// Name -> action, the only lookup a program's tool call needs.
const ACTIONS = new Map<string, AnyAction>(TOOLS.map((action) => [action.name, action]));
const NAMES: string[] = TOOLS.map((action) => action.name);
const HISTORY_ACTIONS = new Map<string, AnyAction>(HISTORY.map((action) => ["history." + action.name, action]));

export interface Executed { done: Done; calls: number }

// Every worker message passes one gate before the host acts on it: it must carry the run's token,
// no tool call is acted on after the done, and at most one done is admitted. A message the gate
// refuses is this call's error and nothing it staged is committed. The rule and its laws are
// proofs/gate.ts; the host steps the compiled machine in src/kernel/verified/gate.ts. The token
// travels on the run message only: a program can replace the worker's onmessage, and a reply that
// echoed the token would hand it over.
const FORGED = "protocol: a message without this run's token, or after its done, was rejected";

export async function execute(
  code: string,
  cwd: string,
  options: { payloads?: Record<string, string>; timeoutMs?: number; store?: Store; mcp?: McpLink; builtin?: BuiltinLink; transcriptPath?: () => string | undefined } = {},
): Promise<Executed> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const js = transpile(code);
  // The one link a built-in tool's run gets: the host's allowlist decides there, before any job.
  const builtin = builtinTools(options.builtin);
  const worker = new Worker(WORKER);
  const token = crypto.randomUUID();
  // Ends every tool call still in flight when the run ends, so a Bash the program started does not
  // outlive it (a timed-out program used to leave its command running to Bash's own timeout).
  const ended = new AbortController();
  let calls = 0;
  let finished = false;
  try {
    const done = await new Promise<Done>((resolve, reject) => {
      const timer = setTimeout(() => {
        finished = true;
        reject(new Error("timed out after " + timeoutMs + "ms"));
      }, timeoutMs);
      const gate = new MessageGate();
      // A message the gate refuses fails the call, so nothing the program staged is committed.
      const refuse = () => {
        finished = true;
        clearTimeout(timer);
        resolve({ kind: "done", token, ok: false, error: FORGED, logs: [], writes: { set: {}, remove: [] } });
      };
      worker.onmessage = async (event: MessageEvent<WorkerToHost>) => {
        if (finished) return;
        const msg = event.data;
        // One gate per run, one step per message: nothing below runs without its verdict.
        const matched = (msg as { token?: unknown } | undefined)?.token === token;
        if (msg?.kind === "done") {
          if (gate.decide(matched, true) !== "done") { refuse(); return; }
          finished = true;
          clearTimeout(timer);
          resolve(msg);
          return;
        }
        if (gate.decide(matched, false) !== "call") { refuse(); return; }
        calls++;
        let reply: HostToWorker;
        try {
          // One mcp call is one job to the mod, decided by the access rule before anything leaves.
          if (msg.ref === MCP_REF) {
            reply = { kind: "reply", id: msg.id, value: await callMcp(options.mcp, msg.args) };
          } else {
            const action = ACTIONS.get(msg.ref) ?? HISTORY_ACTIONS.get(msg.ref);
            if (!action) throw new Error("unknown action " + msg.ref);
            // A bad argument is this call's rejection, catchable inside the program.
            reply = { kind: "reply", id: msg.id, value: await action.run(parseArgs(action, msg.args), { cwd, builtin, signal: ended.signal, transcriptPath: options.transcriptPath?.() }) };
          }
        } catch (error) {
          reply = { kind: "reply", id: msg.id, error: error instanceof Error ? error.message : String(error) };
        }
        if (finished) return;
        worker.postMessage(reply);
      };
      // An error that escapes the program (a throw in a timer callback, a worker that fails to load)
      // sends no "done" message. Treat it as the program's error now, so it is formatted and
      // bounded like any other, instead of waiting for the timeout.
      worker.onerror = (event) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const error = event.error instanceof Error ? event.error.message : event.message || "worker failed with no message";
        resolve({ kind: "done", token, ok: false, error, logs: [], writes: { set: {}, remove: [] } });
      };
      const start: HostToWorker = { kind: "run", token, js, payloads: options.payloads ?? {}, names: NAMES, historyNames: HISTORY.map((action) => action.name), store: options.store?.snapshot() ?? {} };
      worker.postMessage(start);
    });
    return { done, calls };
  } finally {
    ended.abort();
    worker.terminate();
  }
}
