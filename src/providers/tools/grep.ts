import { z } from "zod";
import { defineAction } from "../../registry/action.ts";

export const Grep = defineAction({
  name: "Grep",
  doc: "ripgrep. output_mode defaults to files_with_matches; content gives file:line:text.",
  input: z.object({
    pattern: z.string().min(1).describe("Ripgrep pattern."),
    path: z.string().optional().describe("File or directory to search."),
    glob: z.string().optional().describe("--glob filter, like *.ts."),
    type: z.string().optional().describe("--type filter, like ts."),
    output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
    "-i": z.boolean().optional(),
    "-n": z.boolean().optional(),
    "-A": z.number().optional(),
    "-B": z.number().optional(),
    "-C": z.number().optional(),
    head_limit: z.number().optional().describe("Keep only the first N lines."),
  }),
  output: z.string(),
  positional: ["pattern"],
  run: async (i, { cwd }) => {
    const mode = String(i.output_mode ?? "files_with_matches");
    const argv = ["rg", "--no-heading", "--color=never"];
    if (mode === "files_with_matches") argv.push("-l");
    else if (mode === "count") argv.push("-c");
    else if (i["-n"] !== false) argv.push("-n");
    if (i["-i"]) argv.push("-i");
    if (mode === "content") for (const flag of ["-A", "-B", "-C"] as const) if (i[flag] !== undefined) argv.push(flag, String(i[flag]));
    if (i.glob) argv.push("--glob", String(i.glob));
    if (i.type) argv.push("--type", String(i.type));
    argv.push("--", i.pattern, String(i.path ?? "."));
    const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    if (code > 1) throw new Error("rg failed: " + err.trim());
    const lines = out.split("\n").filter(Boolean).map((line) => line.replace(/^\.\//, ""));
    const limit = i.head_limit === undefined ? lines.length : Number(i.head_limit);
    return lines.slice(0, limit).join("\n");
  },
});
