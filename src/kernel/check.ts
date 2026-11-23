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

export interface CheckResult {
  ok: boolean;
  errors: string[];
  indexTargets?: number[];
  cwdTargets?: number[];
  braceTargets?: number[];
  awaitPropertyTargets?: number[];
  printPropertyTargets?: number[];
  errorPositions?: number[];
}

// Resolve TS7053 to its declaration, and annotate only variables with an indexed assignment.
function indexTargets(program: ts.Program, diagnostics: readonly ts.Diagnostic[]): number[] {
  const targets = new Map<ts.Symbol, number>();
  const checker = program.getTypeChecker();
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== 7053 || !diagnostic.file || diagnostic.start === undefined) continue;
    const file = diagnostic.file;
    const start = diagnostic.start;
    const visit = (node: ts.Node): void => {
      if (node.getStart(file) > start || node.end <= start) return;
      if (ts.isElementAccessExpression(node) && node.getStart(file) === start && ts.isIdentifier(node.expression)) {
        const symbol = checker.getSymbolAtLocation(node.expression);
        const declarations = symbol?.declarations;
        if (symbol && declarations?.length === 1 && ts.isVariableDeclaration(declarations[0]!)) {
          const name = declarations[0].name;
          if (ts.isIdentifier(name)) targets.set(symbol, name.getStart(file) - PREFIX.length);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  const written = new Set<ts.Symbol>();
  const file = program.getSourceFile(GUEST);
  const visit = (node: ts.Node): void => {
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
      let left: ts.Node = node;
      let parent = node.parent;
      while (ts.isParenthesizedExpression(parent)) { left = parent; parent = parent.parent; }
      if (ts.isBinaryExpression(parent) && parent.left === left &&
          parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const symbol = checker.getSymbolAtLocation(node.expression);
        if (symbol && targets.has(symbol)) written.add(symbol);
      }
    }
    ts.forEachChild(node, visit);
  };
  if (file && targets.size) visit(file);
  return [...targets].filter(([symbol, position]) => position >= 0 && written.has(symbol)).map(([, position]) => position);
}

// A local `print` may return void too; only the program global supports this repair.
function printPropertyTargets(program: ts.Program, diagnostics: readonly ts.Diagnostic[]): number[] {
  const checker = program.getTypeChecker();
  const targets: number[] = [];
  const directCallsOnly = new Map<ts.Symbol, boolean>();
  const isUnchangedGlobal = (symbol: ts.Symbol, file: ts.SourceFile): boolean => {
    const cached = directCallsOnly.get(symbol);
    if (cached !== undefined) return cached;
    let unchanged = true;
    const visit = (node: ts.Node): void => {
      // A non-call use can rebind print; direct eval can rebind it without naming it in the AST.
      if (ts.isIdentifier(node) && (node.text === "eval" ||
          (node.text === "print" && checker.getSymbolAtLocation(node) === symbol &&
           !(ts.isCallExpression(node.parent) && node.parent.expression === node)))) unchanged = false;
      ts.forEachChild(node, visit);
    };
    visit(file);
    directCallsOnly.set(symbol, unchanged);
    return unchanged;
  };
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== 2339 || !diagnostic.file || diagnostic.start === undefined ||
        !/^Property .+ does not exist on type 'void'\./.test(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))) continue;
    const file = diagnostic.file;
    const start = diagnostic.start;
    const visit = (node: ts.Node): void => {
      if (node.getStart(file) > start || node.end <= start) return;
      if (ts.isPropertyAccessExpression(node) && node.name.getStart(file) === start &&
          ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "print") {
        const symbol = checker.getSymbolAtLocation(node.expression.expression);
        const declarations = symbol?.declarations;
        if (symbol && declarations?.length === 1 && declarations[0]?.getSourceFile().fileName === DECLARATIONS &&
            isUnchangedGlobal(symbol, file)) {
          targets.push(start - PREFIX.length);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return targets;
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
  const errorPositions = diags.flatMap((d) => d.file && d.start !== undefined && d.start >= PREFIX.length
    ? [d.start - PREFIX.length] : []);
  // Only unresolved `process` identifiers can direct a cwd repair. The repair checks the AST.
  const cwdTargets = diags.flatMap((d) =>
    (d.code === 2591 || d.code === 2304) && d.file && d.start !== undefined && d.length === 7 &&
    d.file.text.slice(d.start, d.start + d.length) === "process" &&
    ts.flattenDiagnosticMessageText(d.messageText, "\n").startsWith("Cannot find name 'process'.")
      ? [d.start - PREFIX.length] : []);
  // TS1005 at a close parenthesis may mean the last object argument is missing its brace.
  const braceTargets = diags.flatMap((d) => d.code === 1005 && d.file && d.start !== undefined &&
    d.start >= PREFIX.length && d.start < PREFIX.length + code.length && d.length === 1 &&
    d.file.text[d.start] === ")" && ts.flattenDiagnosticMessageText(d.messageText, "\n") === "',' expected."
      ? [d.start - PREFIX.length] : []);
  // TS2339 identifies the property token; only a missing property on Promise<T> can authorize
  // an await-precedence repair. The repair checks the precise expression shape.
  const awaitPropertyTargets = diags.flatMap((d) => d.code === 2339 && d.file && d.start !== undefined &&
    /^Property .+ does not exist on type 'Promise<.+>'\./.test(ts.flattenDiagnosticMessageText(d.messageText, "\n"))
      ? [d.start - PREFIX.length] : []);
  const printTargets = printPropertyTargets(program, diags);
  return { ok: errors.length === 0, errors, ...(targets.length ? { indexTargets: targets } : {}),
    ...(cwdTargets.length ? { cwdTargets } : {}), ...(braceTargets.length ? { braceTargets } : {}),
    ...(awaitPropertyTargets.length ? { awaitPropertyTargets } : {}),
    ...(printTargets.length ? { printPropertyTargets: printTargets } : {}),
    ...(errorPositions.length ? { errorPositions } : {}) };
}

export function transpile(code: string): string {
  const out = ts.transpileModule("(async () => {\n" + code + "\n})()", {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
  });
  return out.outputText.replace(/^"use strict";\s*/, "").replace(/^export \{\};\s*/m, "");
}
