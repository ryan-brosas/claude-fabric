import ts from "typescript";

// Guest code is wrapped as an async function body so top-level await and return work.
const PREFIX = "export {};\nasync function __fabric_main(): Promise<unknown> {\n";
const SUFFIX = "\n}\n";
const PREFIX_LINES = 2;
// TS2355 "must return a value": the wrapper declares Promise<unknown> so every return is still
// checked, but a program may end without a return. Drop only that error, and only on the wrapper.
const MISSING_RETURN = 2355;
const GUEST = "/fabric/guest.ts";
const DECLARATIONS = "/fabric/guest.d.ts";

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  lib: ["lib.es2023.d.ts"],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
};

const stable = new Map<string, ts.SourceFile>();
const baseHost = ts.createCompilerHost(options, true);
let previous: ts.Program | undefined;
// The declarations are the same text on every call, so their SourceFile is made once.
let served = "";
let servedFile: ts.SourceFile | undefined;

export interface CheckResult { ok: boolean; errors: string[]; indexTargets?: number[]; cwdTargets?: number[] }

// Resolve TS7053 to the actual declaration, not another variable with the same name.
function indexTargets(program: ts.Program, diagnostics: readonly ts.Diagnostic[]): number[] {
  const targets = new Set<number>();
  const checker = program.getTypeChecker();
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== 7053 || !diagnostic.file || diagnostic.start === undefined) continue;
    const file = diagnostic.file;
    const start = diagnostic.start;
    const visit = (node: ts.Node): void => {
      if (node.getStart(file) > start || node.end <= start) return;
      if (ts.isElementAccessExpression(node) && node.getStart(file) === start && ts.isIdentifier(node.expression)) {
        const declarations = checker.getSymbolAtLocation(node.expression)?.declarations;
        if (declarations?.length === 1 && ts.isVariableDeclaration(declarations[0]!)) {
          const name = declarations[0].name;
          if (ts.isIdentifier(name)) targets.add(name.getStart(file) - PREFIX.length);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return [...targets].filter((position) => position >= 0);
}

export function check(code: string, guest: string): CheckResult {
  if (guest !== served) { served = guest; servedFile = undefined; }
  const text = PREFIX + code + SUFFIX;
  const host: ts.CompilerHost = {
    ...baseHost,
    getSourceFile(name, lang) {
      if (name === GUEST) return ts.createSourceFile(name, text, lang, true);
      if (name === DECLARATIONS) return (servedFile ??= ts.createSourceFile(name, guest, lang, true));
      const hit = stable.get(name);
      if (hit) return hit;
      const file = baseHost.getSourceFile(name, lang);
      if (file) stable.set(name, file);
      return file;
    },
    fileExists: (name) => name === GUEST || name === DECLARATIONS || baseHost.fileExists(name),
  };
  const program = ts.createProgram({ rootNames: [GUEST, DECLARATIONS], options, host, oldProgram: previous });
  previous = program;
  const diags = ts.getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === GUEST || !d.file)
    .filter((d) => !(d.code === MISSING_RETURN && d.start !== undefined && d.start < PREFIX.length));
  const errors = diags.map((d) => {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (!d.file || d.start === undefined) return msg;
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    return "line " + (line + 1 - PREFIX_LINES) + ":" + (character + 1) + " " + msg;
  });
  const targets = indexTargets(program, diags);
  // Only unresolved `process` identifiers can direct a cwd repair. The repair checks the AST.
  const cwdTargets = diags.flatMap((d) =>
    (d.code === 2591 || d.code === 2304) && d.file && d.start !== undefined && d.length === 7 &&
    d.file.text.slice(d.start, d.start + d.length) === "process" &&
    ts.flattenDiagnosticMessageText(d.messageText, "\n").startsWith("Cannot find name 'process'.")
      ? [d.start - PREFIX.length] : []);
  return { ok: errors.length === 0, errors, ...(targets.length ? { indexTargets: targets } : {}),
    ...(cwdTargets.length ? { cwdTargets } : {}) };
}

export function transpile(code: string): string {
  const out = ts.transpileModule("(async () => {\n" + code + "\n})()", {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
  });
  return out.outputText.replace(/^"use strict";\s*/, "").replace(/^export \{\};\s*/m, "");
}
