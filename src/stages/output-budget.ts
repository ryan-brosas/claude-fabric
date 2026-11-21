// Adapted from pi-fabric (MIT, Tom X Nguyen) src/output-budget.ts at d331f629; the result text is
// the whole result (there is no separate full output to keep), the artifact is written into a fresh
// private directory, the fallback cut is injected so this stage imports no kernel file, the
// lengths it returns are checked against the compiled machine in verified/, and the marker says
// what was cut in this repo's words. It imports node:fs, so the mod (which may import no bare
// module) must not import this stage.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptBudget } from "./verified/output-budget.ts";

export type Writer = (content: string) => Promise<string>;

const READ_HINT = "\nTop-level Read returns full files; call it, not programs.";

/** How many chars of the text fit beside the suffix. One char keeps a marker possible. */
export function bodyBudget(max: number, suffixLength: number): number {
  return Math.max(1, max - suffixLength);
}

/** The last line of a result that was too long to keep whole. */
export const savedLine = (chars: number, path: string): string =>
  "\n[Full result (" + chars + " chars) saved to: " + path + "]";

/**
 * The head and tail of a text, with a marker where the middle was cut. Never longer than max:
 * when the marker alone would not fit, the head is the whole allowance.
 */
export function cutMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = "\n\n... " + (text.length - max) + " chars cut from the middle ...\n\n";
  if (marker.length >= max) return text.slice(0, max);
  const available = max - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

/** A private file under the plugin's data dir when there is one, else a fresh temp dir. */
const writePrivate: Writer = async (content) => {
  const base = process.env.CLAUDE_PLUGIN_DATA || tmpdir();
  const directory = await mkdtemp(join(base, "fabric-result-"));
  try {
    const file = join(directory, "result.txt");
    await writeFile(file, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return file;
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
};

export interface BudgetOptions {
  /** The formatted result. */
  text: string;
  /** The cap the model sees. */
  max: number;
  /** What to return when the whole text cannot be saved: the kernel's own cut. */
  fallback: (text: string, max: number) => string;
  /** Where the whole text goes; defaults to a private file in a fresh directory. */
  write?: Writer;
}

/**
 * The result cut to the cap: whole when it fits, otherwise a Read hint and, when saved, a last
 * line naming the private file that holds all of it. Never longer than max.
 */
export async function outputBudget(options: BudgetOptions): Promise<string> {
  const { text, max, fallback } = options;
  let out: string;
  // What the lengths were on the path this call took; zero where a path did not run.
  let suffix = 0;
  let fallbackLength = 0;
  let wrote = false;
  if (text.length <= max) {
    out = text;
  } else {
    let path: string | undefined;
    try {
      path = await (options.write ?? writePrivate)(text);
    } catch {
      path = undefined;
    }
    const ending = READ_HINT + (path === undefined ? "" : savedLine(text.length, path));
    suffix = ending.length;
    const room = bodyBudget(max, suffix);
    let body: string;
    if (path === undefined) {
      // The kernel cut appends its marker past its budget. Keep it when it fits, otherwise use the
      // bounded middle cut, leaving room for the hint on either path.
      const cut = fallback(text, room);
      fallbackLength = cut.length;
      body = cut.length <= room ? cut : cutMiddle(text, room);
    } else {
      wrote = true;
      body = cutMiddle(text, room);
    }
    // If the cap cannot hold the suffix, keep its tail: on the saved path the file path is last.
    const kept = body + ending;
    out = kept.length > max ? ending.slice(-max) : kept;
  }
  // The length arithmetic is the compiled machine's (src/stages/verified/output-budget.ts, with its
  // laws in proofs/output-budget.ts): a result the machine does not predict is a bug in this stage,
  // so it fails here instead of reaching the model.
  if (!acceptBudget({ text: text.length, max, suffix, fallback: fallbackLength, wrote }, out.length)) {
    throw new Error("fabric: the result budget failed its verified check");
  }
  return out;
}
