import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import ts from "typescript";

// Two rules a mod's source has to keep, both read here with TypeScript's own parser:
//
//   1. A mod may import only files inside the plugin, and only type declarations from claude-code.
//      The hooks worker refuses anything else.
//   2. `$` is never a value. The hooks compiler refuses a `$` handed to another function or module,
//      so every `$` call is spelled inside a hook body.

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

/** The hooks compiler's words: the rule a failure repeats, because a mod's `$` has one spelling. */
const DOLLAR_RULE = "$ itself is passed as an argument (bound, passed, spread, returned or read); " +
  "$ is always spelled $.noun.event(...) at the call site, on is always on(\"<event>\", hook), and " +
  "next.to always next.to(e, \"<tier>\")";

/** Where the compiler allows a `$`: a hook's own parameter, or the object of `$.noun`. */
function dollarAllowed(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isParameter(parent) && parent.name === node) return true;
  return ts.isPropertyAccessExpression(parent) && parent.expression === node;
}

/** Every `$` that is a value, each with the rule it broke and the fix. */
function dollarFindings(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const lines = text.split("\n");
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "$" && !dollarAllowed(node)) {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      const spelled = (lines[line] ?? "").trim();
      findings.push(
        `${file}:${line + 1}:${character + 1} uses \`$\` as a value: ${spelled}\n` +
        `The hooks compiler refuses it: "${DOLLAR_RULE}".\n` +
        "Fix: spell the call `$.noun.method(...)` at the call site inside the hook body in " +
        "src/mod/index.ts, and give a helper in src/mod/bridge.ts plain data to answer with.",
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

// Every module under a folder, following relative imports from each file found there.
async function scanTree<T>(root: string, scan: (file: string, text: string) => T[]): Promise<T[]> {
  const seen = new Set<string>();
  const findings: T[] = [];
  const queue: string[] = [];
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root })) queue.push(resolve(root, file));
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await Bun.file(file).text();
    findings.push(...scan(file, text));
    for (const { specifier, dynamic } of importsOf(text)) {
      if (!dynamic && specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier));
    }
  }
  return findings;
}

const modRoot = (): string => new URL("../../src/mod/", import.meta.url).pathname;

test("the mod imports only relative files, and only a type from claude-code", async () => {
  expect(await scanTree(modRoot(), scanSource)).toEqual([]);
});

test("the mod spells every $ call inside a hook body, and hands no helper a $", async () => {
  // A `$` handed to another function or module does not load: the compiler refuses it, and
  // `claude plugin validate` reports it as an error.
  expect(await scanTree(modRoot(), dollarFindings)).toEqual([]);
});

const brokenSource = {
  "passed to another function": 'on("session.start", ($, e, next) => { start($); return next(e); });',
  "returned": 'on("session.start", ($, e, next) => $);',
  "spread into an array": 'on("session.start", ($, e, next) => [...$]);',
  "spread into an object": 'on("session.start", ($, e, next) => ({ ...$, e }));',
  "stored in a variable": 'on("session.start", ($, e, next) => { const kept = $; return next(e); });',
  "read through an index": 'on("session.start", ($, e, next) => $["http"]);',
  "put in an object by shorthand": 'on("session.start", ($, e, next) => ({ $, e }));',
} as const;

test.each(Object.keys(brokenSource))("the check names the rule when $ is %s", (name) => {
  const findings = dollarFindings("inline.ts", brokenSource[name as keyof typeof brokenSource]);
  expect(findings.length).toBeGreaterThan(0);
  for (const finding of findings) {
    expect(finding).toContain(DOLLAR_RULE);
    expect(finding).toContain("Fix: spell the call");
  }
});

test("the check allows a hook's parameter and a literal $.noun.method(...) beside it", () => {
  const text = [
    'on("session.start", ($, e, next) => {',
    "  void (async () => {",
    '    await $.http.fetch("http://bridge/next", { socketPath: "/tmp/s.sock" });',
    "  })();",
    "  return next(e);",
    '}).catch(($, e, next) => next(e));',
  ].join("\n");
  expect(dollarFindings("inline.ts", text)).toEqual([]);
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
