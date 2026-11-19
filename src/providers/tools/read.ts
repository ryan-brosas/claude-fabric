import { resolve } from "node:path";
import { z } from "zod";
import { defineAction } from "../../registry/action.ts";

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_BYTES = 50 * 1024;

export const Read = defineAction({
  name: "Read",
  doc: "Output is numbered like cat -n; at most 2000 lines, and a notice says how to continue.",
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
    const offset = Math.max(1, Number(i.offset ?? 1));
    const limit = Math.min(Number(i.limit ?? MAX_LINES), MAX_LINES);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    let out = slice
      .map((line, n) => String(offset + n).padStart(6) + "\t" + (line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + "…" : line))
      .join("\n");
    if (out.length > MAX_BYTES) out = out.slice(0, MAX_BYTES);
    const end = offset - 1 + slice.length;
    return end < lines.length ? out + "\n[Showing lines " + offset + "-" + end + " of " + lines.length + ". Use offset=" + (end + 1) + " to continue.]" : out;
  },
});
