// Summarize one benchmark results file. Transcript metrics cover only runs found on this machine.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

type Row = {
  arm: string; task: string; n: number; name: string; pass: boolean;
  error?: string; sessionId?: string; configDir?: string; total?: number; calls?: number; seconds?: number;
  cacheRead?: number; output?: number; tools?: Record<string, number>;
};
type Block = {
  type?: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean;
  input?: { code?: string | string[] }; content?: string | { text?: string }[];
};
type TranscriptRow = { message?: { content?: Block[] } };

const resultPath = process.env.BENCH_RESULTS ?? join(import.meta.dir, "..", "notes/bench/results.jsonl");
const rows: Row[] = readFileSync(resultPath, "utf8").split("\n").filter((line) => line.trim()).map((line, i) => {
  try { return JSON.parse(line) as Row; } catch { throw new Error(`Invalid JSON in ${resultPath}, row ${i + 1}`); }
});
const arms = [...new Set(rows.map((row) => row.arm))];
const completed = (rs: Row[]) => rs.filter((row) => !row.error);
const values = (rs: Row[], key: "total" | "calls" | "seconds" | "cacheRead" | "output") =>
  rs.map((row) => row[key]).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
const mean = (ns: number[]) => ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
const round = (n: number | null, places = 0) => n === null ? null : Number(n.toFixed(places));
const median = (ns: number[]) => {
  if (!ns.length) return null;
  const sorted = [...ns].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const sum = Object.fromEntries(arms.map((arm) => {
  const rs = rows.filter((row) => row.arm === arm), runs = completed(rs), totals = values(runs, "total");
  const tools: Record<string, number> = {};
  for (const row of runs) for (const [name, count] of Object.entries(row.tools ?? {})) tools[name] = (tools[name] ?? 0) + count;
  return [arm, { rows: rs.length, runs: runs.length, passed: runs.filter((row) => row.pass).length,
    driverErrors: rs.length - runs.length, tokenSamples: totals.length, meanTotal: round(mean(totals)),
    medianTotal: median(totals), minTotal: totals.length ? Math.min(...totals) : null,
    maxTotal: totals.length ? Math.max(...totals) : null, meanCalls: round(mean(values(runs, "calls")), 2),
    meanSeconds: round(mean(values(runs, "seconds")), 2), meanCacheRead: round(mean(values(runs, "cacheRead"))),
    meanOutput: round(mean(values(runs, "output"))), tools }];
}));
console.log("Per arm (runs exclude driver-error rows; tokenSamples shows the metric denominator):");
console.log(JSON.stringify(sum, null, 2));

console.log("\nPer task (passes/completed runs, mean total tokens; driver errors excluded):");
console.log(["task", ...arms, "fabric/native"].join(" | "));
for (const task of [...new Set(rows.map((row) => row.task))].sort()) {
  const cells = Object.fromEntries(arms.map((arm) => {
    const rs = completed(rows.filter((row) => row.task === task && row.arm === arm));
    return [arm, { passed: rs.filter((row) => row.pass).length, runs: rs.length, mean: mean(values(rs, "total")) }];
  }));
  const fabric = cells.fabric?.mean, native = cells.native?.mean;
  console.log([task, ...arms.map((arm) => {
    const c = cells[arm]!; return `${c.passed}/${c.runs} ${c.mean === null ? "n/a" : Math.round(c.mean)}`;
  }), fabric != null && native != null && native !== 0 ? (fabric / native).toFixed(2) : "n/a"].join(" | "));
}

// Count call expressions rather than mentions in strings or comments. MCP calls are a tool kind too.
function programShape(code: string) {
  const file = ts.createSourceFile("program.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const kinds = new Set<string>();
  let promiseAll = false;
  const builtins = new Set(["Bash", "Read", "Grep", "Glob", "Edit", "Write", "WebSearch"]);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const fn = node.expression;
      if (ts.isIdentifier(fn) && builtins.has(fn.text)) kinds.add(fn.text);
      if (ts.isPropertyAccessExpression(fn)) {
        if (ts.isIdentifier(fn.expression) && fn.expression.text === "Promise" && fn.name.text === "all") promiseAll = true;
        let base: ts.Expression = fn;
        while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base)) base = base.expression;
        if (ts.isIdentifier(base) && base.text === "mcp") kinds.add(fn.getText(file));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { promiseAll, multipleKinds: kinds.size > 1 };
}

if (arms.includes("fabric")) {
  const fabricRows = rows.filter((row) => row.arm === "fabric");
  const dirsByRoot = new Map<string, string[]>();
  // Same lookup as analysis/programs.ts; a result name is the end of its encoded project path.
  const find = (row: Row) => {
    if (!row.name || !row.sessionId) return undefined;
    const root = join(row.configDir ?? process.env.BENCH_CONFIG_DIR ?? join(process.env.HOME ?? "", ".claude"), "projects");
    let dirs = dirsByRoot.get(root);
    if (!dirs) {
      dirs = existsSync(root) ? readdirSync(root) : [];
      dirsByRoot.set(root, dirs);
    }
    for (const dir of dirs) if (dir.endsWith(row.name.replace(/[^a-zA-Z0-9]/g, "-"))) {
      const file = join(root, dir, row.sessionId + ".jsonl");
      if (existsSync(file)) return file;
    }
    return undefined;
  };
  const missing: string[] = [];
  const wasted = { typeCheck: 0, bashNonzero: 0, refusedTopLevel: 0, otherFabricExec: 0 };
  let found = 0, programs = 0, promiseAll = 0, multipleKinds = 0, malformedLines = 0;
  const resultSizes: number[] = [];
  for (const row of fabricRows) {
    const file = find(row);
    if (!file) { missing.push(`${row.name} (${row.arm}/${row.task}/${row.n}${row.sessionId ? ", transcript not found" : ", no sessionId"})`); continue; }
    let transcript: string;
    try { transcript = readFileSync(file, "utf8"); } catch (error) {
      missing.push(`${row.name} (${row.arm}/${row.task}/${row.n}, unreadable: ${String(error)})`); continue;
    }
    found++;
    const ids = new Map<string, string>();
    for (const line of transcript.split("\n")) {
      if (!line.trim()) continue;
      let entry: TranscriptRow;
      try { entry = JSON.parse(line) as TranscriptRow; } catch { malformedLines++; continue; }
      if (!Array.isArray(entry.message?.content)) continue;
      for (const block of entry.message.content) {
        if (block.type === "tool_use" && block.id && block.name) {
          ids.set(block.id, block.name);
          if (!block.name.endsWith("fabric_exec")) continue;
          programs++;
          const code = Array.isArray(block.input?.code) ? block.input.code.join("\n") : String(block.input?.code ?? "");
          const shape = programShape(code);
          if (shape.promiseAll) promiseAll++;
          if (shape.multipleKinds) multipleKinds++;
        } else if (block.type === "tool_result") {
          const name = ids.get(block.tool_use_id ?? "") ?? "";
          const text = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map((part) => part.text ?? "").join("") : "";
          if (!name.endsWith("fabric_exec")) {
            if (name && block.is_error && /No such tool available/i.test(text)) wasted.refusedTopLevel++;
            continue;
          }
          resultSizes.push(text.length);
          if (/^(?:Type errors?\b|error TS\d+)/i.test(text)) wasted.typeCheck++;
          else if (/^Error:\s*Bash exited\s+(?:with\s+)?(?:code\s+)?[1-9]\d*\b/i.test(text)) wasted.bashNonzero++;
          else if (block.is_error || /^Error:/.test(text)) wasted.otherFabricExec++;
        }
      }
    }
  }
  resultSizes.sort((a, b) => a - b);
  // Same percentile convention as analysis/programs.ts: sorted[floor(n * p)].
  const percentile = (p: number) => resultSizes[Math.floor(resultSizes.length * p)] ?? null;
  const wastedTotal = Object.values(wasted).reduce((a, b) => a + b, 0);
  console.log("\nFabric transcript analysis (per-run means use transcripts found):");
  console.log(JSON.stringify({ runRows: fabricRows.length, transcriptsFound: found, missingTranscripts: missing.length, missing,
    malformedLines, programs, programsPerRun: round(found ? programs / found : null, 2), wastedRequests: wasted, wastedTotal,
    wastedRequestsPerRun: round(found ? wastedTotal / found : null, 2), programsWithPromiseAll: promiseAll,
    programsWithMultipleToolKinds: multipleKinds, resultSizes: { count: resultSizes.length, p50: percentile(0.5), p90: percentile(0.9),
      max: resultSizes.at(-1) ?? null, over4000: resultSizes.filter((size) => size > 4000).length } }, null, 2));
}

if (sum.fabric && sum.native && sum.fabric.meanTotal !== null && sum.native.meanTotal !== null && sum.native.meanTotal !== 0) {
  const ratio = sum.fabric.meanTotal / sum.native.meanTotal;
  console.log(`fabric/native tokens: ${ratio.toFixed(3)}; passed ${sum.fabric.passed} vs ${sum.native.passed}; step 6 ${sum.fabric.passed >= sum.native.passed && ratio <= 1.1 ? "PASSES" : "does not pass"}`);
}
