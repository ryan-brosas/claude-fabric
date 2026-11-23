import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

test("report reads the default results relative to its checkout, not the working directory", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "report-default-"));
  try {
    const bench = join(tmp, "bench");
    const results = join(tmp, "notes/bench");
    mkdirSync(bench);
    mkdirSync(results, { recursive: true });
    cpSync(join(import.meta.dir, "report.ts"), join(bench, "report.ts"));
    writeFileSync(join(results, "results.jsonl"), JSON.stringify({ arm: "native", task: "01", n: 1, name: "sample", pass: true, total: 42 }));
    const modules = dirname(dirname(import.meta.resolveSync("typescript/package.json")));
    const proc = Bun.spawn(["bun", join(bench, "report.ts")], {
      cwd: bench, env: { ...process.env, BENCH_RESULTS: undefined, NODE_PATH: [modules, process.env.NODE_PATH].filter(Boolean).join(delimiter) },
      stdout: "pipe", stderr: "pipe",
    });
    const [output, error, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ exit, error }).toEqual({ exit: 0, error: "" });
    expect(output).toContain('"meanTotal": 42');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("report separates driver errors, missing transcripts and distinct wasted requests", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "report-test-"));
  try {
    const dir = join(tmp, ".claude/projects/project--fabric-01-1-test");
    mkdirSync(dir, { recursive: true });
    const rows = [
      { arm: "native", task: "01", n: 1, name: "native-01-1-test", pass: true, total: 100, calls: 2, seconds: 3 },
      { arm: "fabric", task: "01", n: 1, name: "fabric-01-1-test", sessionId: "session", pass: true, total: 80, calls: 4, seconds: 5 },
      { arm: "fabric", task: "01", n: 1, name: "fabric-01-1-error", pass: false, error: "no Stop" },
      { arm: "fabric", task: "02", n: 1, name: "fabric-02-1-missing", sessionId: "missing", pass: false, total: 40, calls: 1, seconds: 2 },
    ];
    const results = join(tmp, "results.jsonl");
    writeFileSync(results, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const use = (id: string, name: string, code = "") => ({ type: "tool_use", id, name, input: { code } });
    const result = (id: string, content: string, is_error = false) => ({ type: "tool_result", tool_use_id: id, content, is_error });
    const fabric = "mcp__plugin_fabric_fabric__fabric_exec";
    const blocks = [
      use("a", fabric, "await Promise.all([Read({}), Bash({})]);"), result("a", "successful program output\nerror TS9999: example text"),
      use("b", fabric, "const text = 'Promise.all([Read(), Bash()])'; Write({});"), result("b", "Type errors; code was not executed:\nline 1:1 oops"),
      use("c", fabric, "Bash({});"), result("c", "Error: Bash exited 2: bad"),
      use("d", fabric, "Read({});"), result("d", "Error: another fabric failure", true),
      use("e", "Edit"), result("e", "Error: No such tool available: Edit", true),
      use("f", "Read"), result("f", "A file mentioning No such tool available is not a refusal"),
    ];
    writeFileSync(join(dir, "session.jsonl"), blocks.map((block) => JSON.stringify({ message: { content: [block] } })).join("\n") + "\n");
    const proc = Bun.spawn(["bun", join(import.meta.dir, "report.ts")], {
      env: { ...process.env, HOME: tmp, BENCH_CONFIG_DIR: undefined, BENCH_RESULTS: results }, stdout: "pipe", stderr: "pipe",
    });
    const [output, error, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ exit, error }).toEqual({ exit: 0, error: "" });
    const armText = output.split("Per arm (runs exclude driver-error rows; tokenSamples shows the metric denominator):\n")[1]!.split("\n\nPer task")[0]!;
    const arms = JSON.parse(armText);
    expect(arms.fabric).toMatchObject({ rows: 3, runs: 2, passed: 1, driverErrors: 1, meanTotal: 60, medianTotal: 60, minTotal: 40, maxTotal: 80, meanCalls: 2.5, meanSeconds: 3.5 });
    expect(output).toContain("01 | 1/1 100 | 1/1 80 | 0.80");
    const analysisText = output.split("Fabric transcript analysis (per-run means use transcripts found):\n")[1]!.split("\nfabric/native tokens:")[0]!;
    const analysis = JSON.parse(analysisText);
    expect(analysis).toMatchObject({ runRows: 3, transcriptsFound: 1, missingTranscripts: 2, malformedLines: 0, programs: 4, programsPerRun: 4,
      wastedRequests: { typeCheck: 1, bashNonzero: 1, refusedTopLevel: 1, otherFabricExec: 1 }, wastedTotal: 4, wastedRequestsPerRun: 4,
      programsWithPromiseAll: 1, programsWithMultipleToolKinds: 1, resultSizes: { count: 4, over4000: 0 } });
    expect(analysis.missing.join("\n")).toContain("fabric-01-1-error");
    expect(analysis.missing.join("\n")).toContain("fabric-02-1-missing");
    expect(output).toContain("fabric/native tokens: 0.600; passed 1 vs 1; step 6 PASSES");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("report resolves transcript profiles in row, environment, then default order", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "report-roots-"));
  try {
    const defaults = join(tmp, ".claude");
    const envProfile = join(tmp, "env-profile");
    const rowProfile = join(tmp, "row-profile");
    const missingProfile = join(tmp, "missing-profile");
    const results = join(tmp, "results.jsonl");
    const row = { arm: "fabric", task: "lookup", n: 1, name: "fabric-lookup", sessionId: "session", pass: true };
    for (const [profile, count] of [[defaults, 1], [envProfile, 2], [rowProfile, 3]] as const) {
      const dir = join(profile, "projects", "project--fabric-lookup");
      mkdirSync(dir, { recursive: true });
      const block = { type: "tool_use", id: "call", name: "mcp__plugin_fabric_fabric__fabric_exec", input: { code: "Read({});" } };
      writeFileSync(join(dir, "session.jsonl"), Array.from({ length: count }, () => JSON.stringify({ message: { content: [block] } })).join("\n"));
    }
    const report = async (configDir?: string) => {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "report.ts")], {
        env: { ...process.env, HOME: tmp, BENCH_CONFIG_DIR: configDir, BENCH_RESULTS: results }, stdout: "pipe", stderr: "pipe",
      });
      const [output, error, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect({ exit, error }).toEqual({ exit: 0, error: "" });
      return JSON.parse(output.split("Fabric transcript analysis (per-run means use transcripts found):\n")[1]!);
    };
    writeFileSync(results, JSON.stringify(row));
    expect(await report()).toMatchObject({ transcriptsFound: 1, missingTranscripts: 0, programs: 1 });
    expect(await report(envProfile)).toMatchObject({ transcriptsFound: 1, missingTranscripts: 0, programs: 2 });
    writeFileSync(results, JSON.stringify({ ...row, configDir: rowProfile }));
    expect(await report(envProfile)).toMatchObject({ transcriptsFound: 1, missingTranscripts: 0, programs: 3 });
    writeFileSync(results, [JSON.stringify(row), JSON.stringify({ ...row, configDir: rowProfile })].join("\n"));
    expect(await report(envProfile)).toMatchObject({ runRows: 2, transcriptsFound: 2, missingTranscripts: 0, programs: 5 });
    writeFileSync(results, JSON.stringify({ ...row, configDir: missingProfile }));
    expect(await report(envProfile)).toMatchObject({ transcriptsFound: 0, missingTranscripts: 1, programs: 0 });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
