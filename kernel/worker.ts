// One fresh Worker per fabric_exec call. Every tool call crosses to the host.
import { TOOL_NAMES, type HostToWorker, type ToolName, type WorkerToHost } from "./protocol.ts";
declare const self: Worker;
let next = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const logs: string[] = [];

const send = (msg: WorkerToHost) => self.postMessage(msg);

const call = (ref: ToolName, args: unknown[]) =>
  new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    send({ kind: "call", id, ref, args });
  });

const toolFns = TOOL_NAMES.map((name) => (...args: unknown[]) => call(name, args));
const print = (...values: unknown[]) => { logs.push(values.map((v) => typeof v === "string" ? v : JSON.stringify(v)).join(" ")); };

self.onmessage = async (event: MessageEvent<HostToWorker>) => {
  const msg = event.data;
  if (msg.kind === "reply") {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (!p) return;
    if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.value);
    return;
  }
  if (msg.kind === "run") {
    try {
      const payloads: Record<string, string> = msg.payloads ?? {};
      const π = new Proxy(payloads, {
        get: (t, key) => {
          if (typeof key !== "string" || key in t) return (t as Record<string | symbol, unknown>)[key];
          throw new Error(`π.${key} is not in this call's payloads. Provided keys: ${Object.keys(t).join(", ") || "(none)"}`);
        },
      });
      const run = new Function(...TOOL_NAMES, "print", "π", "return " + msg.js);
      const value = await run(...toolFns, print, π);
      send({ kind: "done", value, logs });
    } catch (error) {
      send({ kind: "done", error: error instanceof Error ? error.message : String(error), logs });
    }
  }
};
