import { run } from "./host.ts";

const cwd = process.argv[2] ?? process.cwd();
const programs: Record<string, string> = {
  read: `const pkg = JSON.parse(await pi.read("package.json")); return { name: pkg.name, deps: Object.keys(pkg.dependencies ?? {}) };`,
  parallel: `const [hits, status, head] = await Promise.all([
  pi.grep({ pattern: "export function", path: "kernel" }),
  pi.bash("git status --short"),
  pi.read("README.md", { limit: 3 }),
]);
print("grep hits:", hits.split("\\n").filter(Boolean).length);
return { status: status.output.trim(), head };`,
  typeError: `const n: number = await pi.read("package.json"); return n;`,
  bashFail: `return await pi.bash("exit 3");`,
};

const rows: Record<string, unknown>[] = [];
for (const [name, code] of Object.entries(programs)) {
  const r = await run(code, cwd);
  rows.push({ name, ok: r.ok, checkMs: +r.ms.check.toFixed(1), runMs: +r.ms.run.toFixed(1), calls: r.calls, text: r.text.slice(0, 300) });
}
// Warm repeats: the cost a session pays after the first call.
const warm: number[] = [];
for (let i = 0; i < 10; i++) { const r = await run(programs.read, cwd); warm.push(r.ms.check + r.ms.run); }
console.log(JSON.stringify({ rows, warmMeanMs: +(warm.reduce((a, b) => a + b, 0) / warm.length).toFixed(1) }, null, 2));

// Each sample program has one expected outcome; any mismatch fails the run.
const by = Object.fromEntries(rows.map((r) => [r.name, r])) as Record<string, { ok: boolean; calls: number; text: string }>;
const expectations: [string, boolean][] = [
  ["read returns package name", by.read.ok && by.read.text.includes('"claude-fabric"')],
  ["parallel makes 3 calls and keeps print output", by.parallel.ok && by.parallel.calls === 3 && by.parallel.text.startsWith("grep hits:")],
  ["type error stops before running", !by.typeError.ok && by.typeError.calls === 0 && by.typeError.text.includes("not assignable")],
  ["nonzero bash rejects", !by.bashFail.ok && by.bashFail.text.includes("exited 3")],
];
const failed = expectations.filter(([, pass]) => !pass).map(([name]) => name);
if (failed.length) { console.error("FAILED: " + failed.join("; ")); process.exit(1); }
console.log("all " + expectations.length + " expectations passed");
