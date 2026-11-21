#!/usr/bin/env bun
// Trimmed from pi-fabric (MIT, Tom X Nguyen) scripts/verified-kernels.ts at d331f629; only the
// artifacts this repo ships, no --artifact mode, and a byte comparison instead of a receipt.
// Proves the registered gdp-wired kernels and compiles them to the modules their stage or
// compactor executes. --check also compares every artifact with the committed file, so a proved
// rule and the code that runs it cannot drift apart.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { ProofTask, ProofResult } from "./proof-worker.ts";

/** Extract the known compiler layout without admitting new top-level code. */
export function splitCompiled(compiled: string, id: string): { helpers: Map<string, string>; body: string } {
  const source = ts.createSourceFile("machine.js", compiled, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const refuse = (): never => { throw new Error(`Unrecognized compiled machine layout in ${id}`); };
  if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) refuse();
  const header = compiled.split("\n", 1)[0]!;
  if (!header.startsWith("// Generated from the machine ")) refuse();
  const statements = [...source.statements];
  const helpers = new Map<string, string>();
  while (statements.length > 3) {
    const node = statements.shift()!;
    let name: string | undefined;
    if (ts.isFunctionDeclaration(node) && node.name && !node.modifiers?.length && !node.getText(source).includes("\n")) {
      name = /^function (\$\w+)\(/.exec(node.getText(source))?.[1];
    } else if (ts.isVariableStatement(node) && !node.modifiers?.length &&
      (node.declarationList.flags & ts.NodeFlags.Const) !== 0 && node.declarationList.declarations.length === 1) {
      const declaration = node.declarationList.declarations[0]!;
      if (ts.isIdentifier(declaration.name) && declaration.name.text === "$wordDivisionValue" &&
          declaration.initializer && ts.isFunctionExpression(declaration.initializer) &&
          declaration.initializer.name?.text === "wordDivisionValue" &&
          declaration.initializer.parameters.map((p) => p.getText(source)).join(", ") === "width, part, index, values") name = declaration.name.text;
    }
    const text = node.getText(source);
    if (!name) return refuse();
    if (helpers.has(name) || /\bexport\b|\bimport\b|\brequire\(|\bprocess\b|\bglobalThis\b/.test(text)) refuse();
    helpers.set(name, text);
  }
  const functions = statements.map((node, index) => {
    const names = ["init", "fork", "step"], params = ["params", "state", "params, state, input"];
    if (!ts.isFunctionDeclaration(node) || node.name?.text !== names[index] || !node.body ||
        node.modifiers?.length !== 1 || node.modifiers[0]?.kind !== ts.SyntaxKind.ExportKeyword ||
        node.parameters.map((p) => p.getText(source)).join(", ") !== params[index] ||
        !node.getText(source).startsWith(`export function ${names[index]}(`)) refuse();
    return node.getText(source);
  });
  if (functions.length !== 3 || functions[1]!.split("\n").length !== 3 || !functions[1]!.endsWith("\n}")) refuse();
  const body = [header, functions[0], functions[2]].join("\n").replace(/^export function /gm, "function ");
  if (/\bexport\b|\bimport\b|\brequire\(|\bprocess\b|\bglobalThis\b/.test(body)) throw new Error(`Unexpected host access in ${id}`);
  return { helpers, body };
}

if (import.meta.main) {
const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
const pinned = (): string => {
  const version = (JSON.parse(read("package.json")) as { devDependencies?: Record<string, string> }).devDependencies?.["gdp-wired"];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("gdp-wired must be pinned to an exact devDependency version");
  return version;
};

const mode = process.argv[2];
const explicitJobs = process.argv.length === 5 && process.argv[3] === "--jobs";
const jobs = explicitJobs ? Number(process.argv[4]) : Math.min(4, availableParallelism());
if ((process.argv.length !== 3 && !explicitJobs) || !["--write", "--check"].includes(mode ?? "") ||
    !Number.isSafeInteger(jobs) || jobs < 1 || jobs > 4) {
  throw new Error("Usage: bun scripts/proofs.ts --write|--check [--jobs 1..4]");
}

const installed = (JSON.parse(read("node_modules/gdp-wired/package.json")) as { version: string }).version;
if (installed !== pinned()) throw new Error(`gdp-wired ${pinned()} is pinned, but ${installed} is installed`);
const { modules } = await import("../proofs/index.ts");
const { runWorkerTasks } = await import("./proof-pool.ts");
const started = performance.now();
const plans = modules.map((module) => ({ module, kernels: module.kernels() }));
if (new Set(modules.map((module) => module.stem)).size !== modules.length) {
  throw new Error("Kernel module registry has a duplicate stem");
}
for (const { module, kernels } of plans) {
  if (`proofs/${module.stem}.ts` !== module.source || !/^src\/[a-z-]+\/verified\/generated$/.test(module.out) ||
      new Set(kernels.map((kernel) => kernel.id)).size !== kernels.length) {
    throw new Error(`Invalid kernel module ${module.stem}`);
  }
}
const artifacts = modules.flatMap((module) => [
  `${module.out}/${module.stem}.js`,
  `${module.out}/${module.stem}.d.ts`,
]);
const tasks: ProofTask[] = plans.flatMap(({ module, kernels }) => [
  ...kernels.map((kernel) => ({ kind: "kernel" as const, stem: module.stem, id: kernel.id })),
  { kind: "mutations" as const, stem: module.stem },
]);
console.log(`Checking ${tasks.length - modules.length} kernels and ${modules.reduce((count, module) => count + module.bugs.length, 0)} broken variants with ${jobs} isolated workers`);
const results = await runWorkerTasks<ProofTask, ProofResult>(tasks, {
  worker: new URL("./proof-worker.ts", import.meta.url), jobs,
  onResult(result, task) {
    if (!result || result.kind !== task.kind || result.stem !== task.stem || !Array.isArray(result.failures)) throw new Error("Invalid proof worker result");
    if (task.kind === "kernel") {
      if (result.kind !== "kernel" || result.id !== task.id || typeof result.compiled !== "string") throw new Error("Missing compiled kernel result");
      const kernel = plans.find((plan) => plan.module.stem === task.stem)!.kernels.find((kernel) => kernel.id === task.id)!;
      const names = [...(kernel.laws ?? []), ...(kernel.stepLaws ?? [])].map((law) => law.name).join("; ");
      const expected = [
        ...(kernel.rule && names ? [`${kernel.id}: ${names}`] : []),
        ...(kernel.decisions ?? []).map((decision) => `${kernel.id}: ${decision.name}`),
      ];
      if (JSON.stringify(result.claims) !== JSON.stringify(expected)) throw new Error(`Incomplete proof claims for ${task.stem}.${task.id}`);
      for (const claim of result.claims) console.log(`${result.failures.length ? "failed" : "proved"} ${claim}`);
      console.log(`${result.failures.length ? "failed" : "proved"} ${task.stem}.${task.id} (${Math.round(result.seconds * 1000)} ms)`);
    } else {
      const count = plans.find((plan) => plan.module.stem === task.stem)!.module.bugs.length;
      if (result.kind !== "mutations" || (result.refused !== count && result.failures.length === 0)) throw new Error(`Incomplete mutation refusals for ${task.stem}`);
      console.log(`refused ${result.refused} broken variants of ${task.stem}`);
    }
  },
});
const proved = new Map(results.filter((result): result is Extract<ProofResult, { kind: "kernel" }> => result.kind === "kernel").map((result) => [`${result.stem}.${result.id}`, result]));

const failures = results.flatMap((result) => result.failures);
const files = new Map<string, string>();
for (const { module, kernels } of plans) {
  const header = `// Generated by scripts/proofs.ts from ${module.source} with gdp-wired@${installed}. Do not edit.\n`;
  // Emit each compiler helper once per module, refusing conflicting definitions.
  const helpers = new Map<string, string>();
  const js = kernels.map((kernel) => {
    const compiled = proved.get(`${module.stem}.${kernel.id}`)!.compiled;
    const split = splitCompiled(compiled, kernel.id);
    for (const [name, text] of split.helpers) {
      if (helpers.has(name) && helpers.get(name) !== text) throw new Error(`Unrecognized compiled machine layout in ${kernel.id}`);
      helpers.set(name, text);
    }
    // `fork` copies a state for branching searches; the compactor never branches, so it is not shipped.
    return `export const ${kernel.id} = /* @__PURE__ */ (() => {\n${split.body}\nreturn { init, step };\n})();\n`;
  }).join("\n");
  const dts = [
    "export interface MachineState { scalars: Record<string, number>; maps: Record<string, Map<number, number>>; defaults?: Record<string, number> }",
    "export interface Machine { init(params: object): MachineState; step(params: object, state: MachineState, input: object): MachineState }",
    ...kernels.map((kernel) => `export declare const ${kernel.id}: Machine;`),
  ].join("\n");
  files.set(`${module.out}/${module.stem}.js`, `${header}${[...helpers.values()].join("\n")}\n\n${js}`);
  files.set(`${module.out}/${module.stem}.d.ts`, `${header}${dts}\n`);
}
if (failures.length) throw new Error(`Verified kernels failed:\n${failures.join("\n")}`);

if (mode === "--write") {
  for (const [path, text] of files) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), text);
  }
  console.log(`Wrote ${files.size} verified kernel artifacts.`);
} else {
  const drift = [...files].filter(([path, text]) => { try { return read(path) !== text; } catch { return true; } }).map(([path]) => path);
  if (drift.length) throw new Error(`Generated kernels differ from the proved sources: ${drift.join(", ")}. Run bun run proof:write.`);
  console.log("Verified kernels reproduce byte for byte.");
}
if (new Set(files.keys()).size !== artifacts.length) throw new Error("Artifact inventory changed");
console.log(`Proof verification completed in ${((performance.now() - started) / 1000).toFixed(2)}s (${jobs} workers)`);
}
