import { resolve } from "node:path";

// Phase 0 pi.* tools. Contracts follow Fabric's fabric-exec skill.
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

type Args = unknown[];
const primary = (args: Args, field: string): Record<string, unknown> => {
  const [first, second] = args;
  const base = typeof first === "string" ? { [field]: first } : { ...(first as object) };
  return typeof second === "object" && second ? { ...second, ...base } : base;
};

export const tools = (cwd: string): Record<string, (args: Args) => Promise<unknown>> => ({
  async "pi.read"(args) {
    const a = primary(args, "path");
    const text = await Bun.file(resolve(cwd, String(a.path))).text();
    const lines = text.split("\n");
    const offset = Math.max(1, Number(a.offset ?? 1));
    const limit = Math.min(Number(a.limit ?? MAX_LINES), MAX_LINES);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    let out = slice.join("\n");
    if (out.length > MAX_BYTES) out = out.slice(0, MAX_BYTES);
    const end = offset - 1 + slice.length;
    return end < lines.length ? out + `\n[Showing lines ${offset}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]` : out;
  },
  async "pi.grep"(args) {
    const [first, path, limit] = args;
    const a = typeof first === "string" ? { pattern: first, path, limit } : (first as Record<string, unknown>);
    const argv = ["rg", "-n", "--no-heading"];
    if (a.ignoreCase) argv.push("-i");
    if (a.glob) argv.push("--glob", String(a.glob));
    if (a.context) argv.push("-C", String(a.context));
    argv.push("--", String(a.pattern), String(a.path ?? "."));
    const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out.split("\n").slice(0, Number(a.limit ?? 100)).join("\n");
  },
  async "pi.bash"(args) {
    const a = primary(args, "command");
    const p = Bun.spawn(["bash", "-c", String(a.command)], { cwd: resolve(cwd, String(a.cwd ?? ".")), stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const exitCode = await p.exited;
    const output = out + err;
    if (exitCode !== 0 && !a.settle) throw new Error(`bash exited ${exitCode}: ${output.slice(0, 2000)}`);
    return { ok: exitCode === 0, output, details: { exitCode } };
  },
});
