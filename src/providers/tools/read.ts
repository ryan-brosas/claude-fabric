import { resolve } from "node:path";
import { z } from "zod";
import { defineAction } from "../../registry/action.ts";
import { readAdmission, readPage } from "../../stages/verified/generated/read-continuation.js";

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_BYTES = 50 * 1024;
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** The machine's page decision, for a nonempty sequence of numbered lines. */
function page(offset: number, count: number, total: number) {
  const s = readPage.step({}, readPage.init({}), { offset, count, total }).scalars;
  return { end: s["out.end"]!, next: s["out.next"]!, notice: s["out.notice"] === 1 };
}

/** The notice is also included in the byte budget. */
function notice(offset: number, count: number, total: number): string {
  const p = page(offset, count, total);
  if (!p.notice) return "";
  return "\n[Showing lines " + offset + "-" + p.end + " of " + total + ". Use offset=" + p.next + " to continue.]";
}

export const Read = defineAction({
  name: "Read",
  doc: "Output is numbered like cat -n; at most 2000 lines or 50KB, and a notice says how to continue.",
  input: z.object({
    file_path: z.string().min(1).describe("Path from the project root, or absolute."),
    offset: z.number().optional().describe("First line to read, 1-based."),
    limit: z.number().optional().describe("How many lines to read."),
  }),
  output: z.string(),
  positional: ["file_path"],
  run: async (i, { cwd }) => {
    const file = Bun.file(resolve(cwd, i.file_path));
    if (!(await file.exists())) throw new Error("File does not exist: " + i.file_path);
    const lines = (await file.text()).split("\n");
    const offset = Math.max(1, Math.trunc(i.offset ?? 1));
    const limit = Math.max(1, Math.min(Math.trunc(i.limit ?? MAX_LINES), MAX_LINES));
    if (offset > lines.length) return "";

    const body: string[] = [];
    let bodyBytes = 0;
    let ending = "";
    for (let index = offset - 1; index < lines.length; index++) {
      const line = lines[index]!;
      const cut = line.length > MAX_LINE_CHARS;
      let head = cut ? line.slice(0, MAX_LINE_CHARS) : line;
      // Do not split a surrogate pair at the existing per-line character limit.
      if (cut && /[\uD800-\uDBFF]$/.test(head) && /^[\uDC00-\uDFFF]/.test(line.slice(head.length))) head = head.slice(0, -1);
      const numbered = String(index + 1).padStart(6) + "\t" + head + (cut ? "…" : "");
      const candidateNotice = notice(offset, body.length + 1, lines.length);
      const lineBytes = bytes(numbered) + (body.length ? 1 : 0);
      const decision = readAdmission.step({}, readAdmission.init({}), {
        body: bodyBytes, line: lineBytes, notice: bytes(candidateNotice), cap: MAX_BYTES, count: body.length, limit,
      }).scalars;
      if (decision["out.admit"] !== 1) break;
      body.push(numbered);
      bodyBytes = decision["out.bytes"]!;
      ending = candidateNotice;
    }
    // A 2000-code-unit head is at most 6000 UTF-8 bytes; its numbering and
    // continuation notice leave ample room under 50KB. This guards that assumption.
    if (!body.length) throw new Error("Read: the first line and its notice do not fit the byte limit");
    return body.join("\n") + ending;
  },
});
