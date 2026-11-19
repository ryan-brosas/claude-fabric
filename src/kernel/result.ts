import type { Done } from "./protocol.ts";

export const MAX_RESULT_CHARS = 20_000;

// What reaches the model: print() lines, then the returned value. The outcome is the explicit
// discriminator, not the error's truthiness: a program that throws an empty message failed. A
// program that printed and returned nothing ends at its last line; with no lines either, it says
// "undefined", so the model still sees that nothing came back.
export function format(done: Done): string {
  if (done.ok && done.value === undefined && done.logs.length > 0) return done.logs.join("\n");
  const body = done.ok
    ? typeof done.value === "string" ? done.value : JSON.stringify(done.value, null, 2) ?? "undefined"
    : "Error: " + (done.error ?? "the program failed");
  return [...done.logs, body].join("\n");
}

export function bound(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + `\n[result cut at ${max} chars]` : text;
}
