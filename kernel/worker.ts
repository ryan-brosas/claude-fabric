// One fresh Worker per fabric_exec call. Every pi.* call crosses to the host.
export {};
declare const self: Worker;
let next = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const logs: string[] = [];

const call = (ref: string, args: unknown[]) =>
  new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    self.postMessage({ kind: "call", id, ref, args });
  });

const pi = new Proxy({}, { get: (_t, name: string) => (...args: unknown[]) => call("pi." + name, args) });
const print = (...values: unknown[]) => { logs.push(values.map((v) => typeof v === "string" ? v : JSON.stringify(v)).join(" ")); };

self.onmessage = async (event: MessageEvent) => {
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
      const run = new Function("pi", "print", "return " + msg.js);
      const value = await run(pi, print);
      self.postMessage({ kind: "done", value, logs });
    } catch (error) {
      self.postMessage({ kind: "done", error: error instanceof Error ? error.message : String(error), logs });
    }
  }
};
