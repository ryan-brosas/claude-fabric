import ts from "typescript";
import { dirname, join } from "node:path";

// Guest code is wrapped as an async function body so top-level await and return work.
const PREFIX = "export {};\nasync function __fabric_main(): Promise<unknown> {\n";
const SUFFIX = "\n}\n";
const PREFIX_LINES = 2;
// TS2355 "must return a value": the wrapper declares Promise<unknown> so every return is still
// checked, but a program may end without a return. Drop only that error, and only on the wrapper.
const MISSING_RETURN = 2355;
const GUEST = "/fabric/guest.ts";
const GUEST_TYPES = join(import.meta.dir, "guest.d.ts");

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

export interface CheckResult { ok: boolean; errors: string[] }

export function check(code: string): CheckResult {
  const text = PREFIX + code + SUFFIX;
  const host: ts.CompilerHost = {
    ...baseHost,
    getSourceFile(name, lang) {
      if (name === GUEST) return ts.createSourceFile(name, text, lang, true);
      const hit = stable.get(name);
      if (hit) return hit;
      const file = baseHost.getSourceFile(name, lang);
      if (file) stable.set(name, file);
      return file;
    },
    fileExists: (name) => name === GUEST || baseHost.fileExists(name),
  };
  const program = ts.createProgram({ rootNames: [GUEST, GUEST_TYPES], options, host, oldProgram: previous });
  previous = program;
  const diags = ts.getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === GUEST || !d.file)
    .filter((d) => !(d.code === MISSING_RETURN && d.start !== undefined && d.start < PREFIX.length));
  const errors = diags.map((d) => {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (!d.file || d.start === undefined) return msg;
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    return `line ${line + 1 - PREFIX_LINES}:${character + 1} ${msg}`;
  });
  return { ok: errors.length === 0, errors };
}

export function transpile(code: string): string {
  const out = ts.transpileModule("(async () => {\n" + code + "\n})()", {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
  });
  return out.outputText.replace(/^"use strict";\s*/, "").replace(/^export \{\};\s*/m, "");
}
