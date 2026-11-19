import type { Done } from "./protocol.ts";

export const MAX_RESULT_CHARS = 20_000;

// What reaches the model: print() lines, then the returned value. The outcome is the explicit
// discriminator, not the error's truthiness: a program that throws an empty message failed.
export function format(done: Done): string {
  const body = done.ok
    ? typeof done.value === "string" ? done.value : JSON.stringify(done.value, null, 2) ?? "undefined"
    : "Error: " + (done.error ?? "the program failed");
  return [...done.logs, body].join("\n");
}

export function bound(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + `\n[result cut at ${max} chars]` : text;
}
