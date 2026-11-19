// One fresh Worker per fabric_exec call. Every tool call crosses to the host; store() and load()
// stay here, and the run's staged writes leave with the done message.
import { copyValue, storable, write } from "../stages/store.ts";
import type { CallMessage, DoneMessage, HostToWorker, StoreDelta } from "./protocol.ts";

declare const self: Worker;

// The guest runs from a global-scope Function, so whatever is left on `self` it can call. Keep the
// dedicated post function in this closure and take every post channel off `self` before any
// program runs. Removal is not the guarantee: dynamic import() still reaches node:worker_threads,
// so the run token, held only by this module's closure, is what the host trusts.
const scope = self as unknown as Record<string, unknown>;
const post = (scope.postMessage as (message: unknown) => void).bind(self);
delete scope.postMessage;
for (const name of ["Worker", "MessageChannel", "BroadcastChannel"]) {
  try {
    delete scope[name];
  } catch {
    // A locked global stays reachable; the host's token check still decides what is acted on.
  }
}

let next = 0;
let runToken = "";
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const logs: string[] = [];

// The token is added here, from the closure, so the program never holds it.
const send = (msg: CallMessage | DoneMessage): void => { post({ ...msg, token: runToken }); };

const call = (ref: string, args: unknown[]) =>
  new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    send({ kind: "call", id, ref, args });
  });

const print = (...values: unknown[]) => { logs.push(values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ")); };

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
    runToken = msg.token;
    // The store the run starts from, what it staged, and the keys it touched: only the host
    // commits anything, and only the keys named here.
    let values: Record<string, unknown> = Object.create(null);
    const writes: StoreDelta = { set: Object.create(null) as Record<string, unknown>, remove: [] };
    const load = <T = unknown>(key: string): T | undefined => {
      if (typeof key !== "string") throw new Error("load: the key must be a string");
      return Object.hasOwn(values, key) ? copyValue(values[key] as T) : undefined;
    };
    const store = (key: string, value: unknown): void => {
      if (typeof key !== "string") throw new Error("store: the key must be a string");
      // write() is the one place the value is serialized and the one place it can be refused, so a
      // caught refusal stages nothing and a value's toJSON runs once. Stage the copy it kept, not
      // the program's value: serializing that again would read it a second time.
      const next = write(values, key, value);
      if (value === undefined) {
        delete writes.set[key];
        if (!writes.remove.includes(key)) writes.remove.push(key);
      } else {
        writes.set[key] = next[key];
        const at = writes.remove.indexOf(key);
        if (at !== -1) writes.remove.splice(at, 1);
      }
      values = next;
    };
    try {
      values = storable(msg.store ?? {});
      const payloads: Record<string, string> = msg.payloads ?? {};
      const π = new Proxy(payloads, {
        get: (t, key) => {
          if (typeof key !== "string" || key in t) return (t as Record<string | symbol, unknown>)[key];
          throw new Error("π." + key + " is not in this call's payloads. Provided keys: " + (Object.keys(t).join(", ") || "(none)"));
        },
      });
      // The host names the tools, so this thread stays light: no providers, no schemas.
      const names = msg.names;
      const toolFns = names.map((name) => (...args: unknown[]) => call(name, args));
      const run = new Function(...names, "print", "π", "store", "load", "return " + msg.js);
      const value = await run(...toolFns, print, π, store, load);
      send({ kind: "done", ok: true, value, logs, writes });
    } catch (error) {
      send({ kind: "done", ok: false, error: error instanceof Error ? error.message : String(error), logs, writes });
    }
  }
};
