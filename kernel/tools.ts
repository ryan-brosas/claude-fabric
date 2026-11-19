import { resolve, relative } from "node:path";
import { stat } from "node:fs/promises";
import type { ToolName } from "./protocol.ts";

// Tools available inside a program. Names and fields follow Claude Code's built-in tools.
const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_BYTES = 50 * 1024;
const BASH_DEFAULT_MS = 120_000;
const BASH_MAX_MS = 600_000;

type Args = unknown[];
type Input = Record<string, unknown>;

// One string means the tool's main field; a two- or three-string call maps positionally.
const input = (args: Args, fields: string[]): Input => {
  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) return { ...(args[0] as Input) };
  const out: Input = {};
  args.forEach((value, i) => { if (fields[i] !== undefined) out[fields[i]] = value; });
  return out;
};
const required = (i: Input, field: string): string => {
  const v = i[field];
  if (typeof v !== "string" || v === "") throw new Error(`${field} is required (string)`);
  return v;
};

export const tools = (cwd: string): Record<ToolName, (args: Args) => Promise<unknown>> => {
  const abs = (p: string) => resolve(cwd, p);
  return {
    async Read(args) {
      const i = input(args, ["file_path"]);
      const file = Bun.file(abs(required(i, "file_path")));
      if (!(await file.exists())) throw new Error(`File does not exist: ${i.file_path}`);
      const lines = (await file.text()).split("\n");
      const offset = Math.max(1, Number(i.offset ?? 1));
      const limit = Math.min(Number(i.limit ?? MAX_LINES), MAX_LINES);
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      let out = slice.map((line, n) => `${String(offset + n).padStart(6)}\t${line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + "…" : line}`).join("\n");
      if (out.length > MAX_BYTES) out = out.slice(0, MAX_BYTES);
      const end = offset - 1 + slice.length;
      return end < lines.length ? out + `\n[Showing lines ${offset}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]` : out;
    },
    async Write(args) {
      const i = input(args, ["file_path", "content"]);
      const path = required(i, "file_path");
      if (typeof i.content !== "string") throw new Error("content is required (string)");
      await Bun.write(abs(path), i.content);
      return `Wrote ${i.content.length} chars to ${path}`;
    },
    async Edit(args) {
      const i = input(args, ["file_path", "old_string", "new_string"]);
      const path = required(i, "file_path");
      const oldS = required(i, "old_string");
      if (typeof i.new_string !== "string") throw new Error("new_string is required (string)");
      if (oldS === i.new_string) throw new Error("old_string and new_string are the same");
      const file = Bun.file(abs(path));
      if (!(await file.exists())) throw new Error(`File does not exist: ${path}`);
      const text = await file.text();
      const count = text.split(oldS).length - 1;
      if (count === 0) throw new Error(`old_string not found in ${path}`);
      if (count > 1 && !i.replace_all) throw new Error(`old_string matches ${count} times in ${path}; add context to make it unique or set replace_all: true`);
      await Bun.write(abs(path), i.replace_all ? text.split(oldS).join(i.new_string) : text.replace(oldS, () => i.new_string as string));
      return `Edited ${path} (${i.replace_all ? count : 1} replacement${(i.replace_all ? count : 1) === 1 ? "" : "s"})`;
    },
    async Grep(args) {
      const i = input(args, ["pattern"]);
      const mode = String(i.output_mode ?? "files_with_matches");
      const argv = ["rg", "--no-heading", "--color=never"];
      if (mode === "files_with_matches") argv.push("-l");
      else if (mode === "count") argv.push("-c");
      else if (i["-n"] !== false) argv.push("-n");
      if (i["-i"]) argv.push("-i");
      if (mode === "content") for (const f of ["-A", "-B", "-C"]) if (i[f] !== undefined) argv.push(f, String(i[f]));
      if (i.glob) argv.push("--glob", String(i.glob));
      if (i.type) argv.push("--type", String(i.type));
      argv.push("--", required(i, "pattern"), String(i.path ?? "."));
      const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      const code = await p.exited;
      if (code > 1) throw new Error(`rg failed: ${err.trim()}`);
      const lines = out.split("\n").filter(Boolean).map((l) => l.replace(/^\.\//, ""));
      const limit = i.head_limit === undefined ? lines.length : Number(i.head_limit);
      return lines.slice(0, limit).join("\n");
    },
    async Glob(args) {
      const i = input(args, ["pattern"]);
      const base = abs(String(i.path ?? "."));
      const files: string[] = [];
      for await (const f of new Bun.Glob(required(i, "pattern")).scan({ cwd: base, onlyFiles: true })) {
        if (!f.split("/").includes("node_modules") && !f.startsWith(".git/")) files.push(f);
      }
      const withTime = await Promise.all(files.map(async (f) => ({ f, t: (await stat(resolve(base, f))).mtimeMs })));
      return withTime.sort((a, b) => b.t - a.t).slice(0, 1000).map(({ f }) => relative(cwd, resolve(base, f)));
    },
    async Bash(args) {
      const i = input(args, ["command"]);
      const timeout = Math.min(Number(i.timeout ?? BASH_DEFAULT_MS), BASH_MAX_MS);
      const p = Bun.spawn(["bash", "-c", required(i, "command")], { cwd, stdout: "pipe", stderr: "pipe", timeout, killSignal: "SIGKILL" });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      const exitCode = await p.exited;
      const output = out + err;
      if (p.signalCode === "SIGKILL") throw new Error(`Bash timed out after ${timeout}ms: ${output.slice(-2000)}`);
      if (exitCode !== 0 && !i.allowFailure) throw new Error(`Bash exited ${exitCode}: ${output.slice(-2000)}`);
      return { output, exitCode };
    },
  };
};
