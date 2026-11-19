import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import ts from "typescript";

// A mod may import only files inside the plugin, and only type declarations from claude-code.
// The hooks worker refuses anything else, so this test reads the graph with TypeScript's own
// parser and fails on any.

interface Imported { specifier: string; typeOnly: boolean; dynamic: boolean }
interface Finding { file: string; specifier: string; reason: string }

function importsOf(text: string): Imported[] {
  const found: Imported[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: Boolean(node.importClause?.isTypeOnly), dynamic: false });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly, dynamic: false });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const ref = node.moduleReference.expression;
      found.push({ specifier: ts.isStringLiteral(ref) ? ref.text : "require()", typeOnly: node.isTypeOnly, dynamic: false });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      found.push({ specifier: arg && ts.isStringLiteral(arg) ? arg.text : "import()", typeOnly: false, dynamic: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("scan.ts", text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS));
  return found;
}

function scanSource(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const { specifier, typeOnly, dynamic } of importsOf(text)) {
    if (dynamic) { findings.push({ file, specifier, reason: "dynamic import" }); continue; }
    if (specifier.startsWith(".")) continue;
    if (typeOnly && specifier === "claude-code") continue;
    const reason = specifier.startsWith("node:") ? "node: import" : specifier.includes(":")
      ? "scheme import"
      : typeOnly ? "only a type may come from a bare module" : "bare import";
    findings.push({ file, specifier, reason });
  }
  return findings;
}

// Every module under src/mod, following relative imports from each file found there.
async function scanMod(root: string): Promise<Finding[]> {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  const queue: string[] = [];
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root })) queue.push(resolve(root, file));
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await Bun.file(file).text();
    findings.push(...scanSource(file, text));
    for (const { specifier, dynamic } of importsOf(text)) {
      if (!dynamic && specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier));
    }
  }
  return findings;
}

test("the mod imports only relative files, and only a type from claude-code", async () => {
  const root = new URL("../../src/mod/", import.meta.url).pathname;
  expect(await scanMod(root)).toEqual([]);
});

test("the scanner flags refused imports wherever they sit", () => {
  const cases = [
    'import { x } from "node:fs";',
    'import type { Register } from "claude-code"; import "node:fs";',
    '/* comment */ import { readFile } from "node:fs";',
    'export { x } from "zod";',
    'import fs = require("fs");',
    'const x = import /* comment */ ("node:fs");',
    'const y = await import("./y.ts");',
    'import { register } from "claude-code";',
    'import type { X } from "zod";',
  ];
  for (const text of cases) expect({ text, flagged: scanSource("inline.ts", text).length > 0 }).toEqual({ text, flagged: true });
});

test("the scanner allows relative imports and a type import of claude-code", () => {
  expect(scanSource("inline.ts", 'import type { Register } from "claude-code";\nimport { a } from "../compaction/a.ts";\nexport * from "./b.ts";')).toEqual([]);
});
