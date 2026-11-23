// Adapted from pi-fabric (MIT, Tom X Nguyen) src/runtime/guest-code-repair.ts at d331f629; the
// tool names and path keys are Claude Code's (Read, Write, Edit, Grep, Glob) instead of the Pi
// ones, Grep's pattern and Bash's command are never touched, and this is a candidate rewrite: the
// host grades the program the model sent first and keeps a repair only when the repaired text
// passes where the original did not (Read(/a.txt/.source) is a valid program).

// Silent repairs for high-frequency unquoted path/URL arguments in program tool calls. Models
// often write `Read(/tmp/foo)` or `Read(https://…)`, which TypeScript parses as a regex,
// division, extra arguments or invalid characters — a round trip the check then spends on a pile of
// diagnostics. Only unambiguous path heads are rewritten; a regex-first tool's positional pattern
// and an already-quoted argument are left alone.

import ts from "typescript";

const POSITIONAL_PATH_TOOLS = new Set(["Read", "Write", "Edit"]);
const OBJECT_PATH_TOOLS = new Set(["Read", "Write", "Edit", "Grep", "Glob"]);
const PATH_KEYS = new Set([
  "path",
  "file",
  "filepath",
  "file_path",
  "filePath",
  "pathname",
  "target_file",
  "targetFile",
  "absolutePath",
  "absolute_path",
  "dir",
  "directory",
  "folder",
  "directoryPath",
  "fileAbsolutePath",
]);

const UNICODE_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["\u201c", "\u201d"],
  ["\u2018", "\u2019"],
  ["\u00ab", "\u00bb"],
];

interface Repair {
  start: number;
  end: number;
  text: string;
}

interface PropertyTargets {
  awaited?: readonly number[];
  printed?: readonly number[];
}

const isIdentChar = (char: string | undefined): boolean =>
  char !== undefined && /[A-Za-z0-9_$]/.test(char);

const skipWs = (code: string, index: number, end: number): number => {
  let i = index;
  while (i < end && /[ \t\r\n]/.test(code[i] ?? "")) i++;
  return i;
};

const skipQuoted = (code: string, index: number, quote: string): number => {
  let i = index + 1;
  while (i < code.length) {
    const char = code[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === quote) return i + 1;
    i++;
  }
  return code.length;
};

const readIdent = (code: string, index: number, end: number): { name: string; end: number } | undefined => {
  const start = code[index];
  if (start === undefined || !/[A-Za-z_$]/.test(start)) return undefined;
  let i = index + 1;
  while (i < end && isIdentChar(code[i])) i++;
  return { name: code.slice(index, i), end: i };
};

const isUnquotedPathStart = (code: string, index: number): boolean => {
  const rest = code.slice(index);
  if (rest.startsWith("https://") || rest.startsWith("http://")) return true;
  if (rest.startsWith("./") || rest.startsWith("../") || rest.startsWith("~/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(rest)) return true;
  if (rest.startsWith("/") && !rest.startsWith("//") && !rest.startsWith("/*")) return true;
  return false;
};

const consumeUnquotedPath = (code: string, index: number, end: number): number => {
  let i = index;
  while (i < end) {
    const char = code[i];
    if (char === undefined) break;
    if (char === "," || char === ")" || char === "}" || char === "]" || char === ";") break;
    if (char === "'" || char === '"' || char === "`") break;
    if (char === " " || char === "\t" || char === "\n" || char === "\r") break;
    if (char === "&" && code[i + 1] === "&") break;
    if (char === "|" && code[i + 1] === "|") break;
    i++;
  }
  return i;
};

const quoteSlice = (code: string, start: number, end: number): Repair | undefined => {
  if (end <= start) return undefined;
  return { start, end, text: JSON.stringify(code.slice(start, end)) };
};

const unicodeQuoteRepair = (code: string, index: number, end: number): Repair | undefined => {
  for (const [open, close] of UNICODE_QUOTE_PAIRS) {
    if (!code.startsWith(open, index)) continue;
    const innerStart = index + open.length;
    const innerEnd = code.indexOf(close, innerStart);
    if (innerEnd === -1 || innerEnd >= end) return undefined;
    return {
      start: index,
      end: innerEnd + close.length,
      text: JSON.stringify(code.slice(innerStart, innerEnd)),
    };
  }
  return undefined;
};

const repairPathValue = (code: string, index: number, end: number): Repair | undefined => {
  const unicode = unicodeQuoteRepair(code, index, end);
  if (unicode) return unicode;
  if (!isUnquotedPathStart(code, index)) return undefined;
  return quoteSlice(code, index, consumeUnquotedPath(code, index, end));
};

const skipBalanced = (code: string, index: number, end: number, open: string, close: string): number => {
  let depth = 1;
  let i = index;
  while (i < end && depth > 0) {
    const char = code[i];
    if (char === "/" && code[i + 1] === "/") {
      while (i < end && code[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && code[i + 1] === "*") {
      const stop = code.indexOf("*/", i + 2);
      i = stop === -1 || stop >= end ? end : stop + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      i = skipQuoted(code, i, char);
      continue;
    }
    if (char === "`") {
      i = skipTemplateLiteral(code, i, end);
      continue;
    }
    if (char === open) depth++;
    else if (char === close) depth--;
    i++;
  }
  return i;
};

const skipTemplateLiteral = (code: string, index: number, end: number): number => {
  let i = index + 1;
  while (i < end) {
    const char = code[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === "`") return i + 1;
    if (char === "$" && code[i + 1] === "{") {
      i = skipBalanced(code, i + 2, end, "{", "}");
      continue;
    }
    i++;
  }
  return end;
};

const repairObjectPathKeys = (code: string, openIndex: number, end: number): Repair[] => {
  const repairs: Repair[] = [];
  let depth = 1;
  let i = openIndex;
  while (i < end && depth > 0) {
    const char = code[i];
    if (char === "/" && code[i + 1] === "/") {
      while (i < end && code[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      i = close === -1 || close >= end ? end : close + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const quotedEnd = skipQuoted(code, i, char);
      if (depth === 1) {
        const name = code.slice(i + 1, quotedEnd - 1);
        if (PATH_KEYS.has(name)) {
          let j = skipWs(code, quotedEnd, end);
          if (code[j] === ":") {
            j = skipWs(code, j + 1, end);
            const repair = repairPathValue(code, j, end);
            if (repair) {
              repairs.push(repair);
              i = repair.end;
              continue;
            }
          }
        }
      }
      i = quotedEnd;
      continue;
    }
    if (char === "`") {
      i = skipTemplateLiteral(code, i, end);
      continue;
    }
    if (char === "{") {
      depth++;
      i++;
      continue;
    }
    if (char === "}") {
      depth--;
      i++;
      continue;
    }
    if (depth === 1) {
      const ident = readIdent(code, i, end);
      if (ident && PATH_KEYS.has(ident.name)) {
        let j = skipWs(code, ident.end, end);
        if (code[j] === ":") {
          j = skipWs(code, j + 1, end);
          const repair = repairPathValue(code, j, end);
          if (repair) {
            repairs.push(repair);
            i = repair.end;
            continue;
          }
        }
        i = ident.end;
        continue;
      }
    }
    i++;
  }
  return repairs;
};

const repairCallArgs = (code: string, argStart: number, end: number, tool: string): Repair[] => {
  const i = skipWs(code, argStart, end);
  if (i >= end) return [];
  if (code[i] === "{") {
    return OBJECT_PATH_TOOLS.has(tool) ? repairObjectPathKeys(code, i + 1, end) : [];
  }
  if (!POSITIONAL_PATH_TOOLS.has(tool)) return [];
  const repair = repairPathValue(code, i, end);
  return repair ? [repair] : [];
};

const collectTemplateRepairs = (code: string, index: number, end: number, repairs: Repair[]): number => {
  let i = index + 1;
  while (i < end) {
    const char = code[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === "`") return i + 1;
    if (char === "$" && code[i + 1] === "{") {
      const exprStart = i + 2;
      const exprEnd = skipBalanced(code, exprStart, end, "{", "}");
      repairs.push(...collectRepairs(code, exprStart, exprEnd - 1));
      i = exprEnd;
      continue;
    }
    i++;
  }
  return end;
};

const collectRepairs = (code: string, start: number, end: number): Repair[] => {
  const repairs: Repair[] = [];
  let i = start;
  while (i < end) {
    const char = code[i];
    if (char === "/" && code[i + 1] === "/") {
      while (i < end && code[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      i = close === -1 || close >= end ? end : close + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      i = Math.min(end, skipQuoted(code, i, char));
      continue;
    }
    if (char === "`") {
      i = collectTemplateRepairs(code, i, end, repairs);
      continue;
    }
    // A tool name is an identifier that starts a call, not a member access and not part of a name.
    if (char !== undefined && /[A-Z_$]/.test(char) && !isIdentChar(code[i - 1]) && code[i - 1] !== ".") {
      const tool = readIdent(code, i, end);
      if (tool && OBJECT_PATH_TOOLS.has(tool.name)) {
        const paren = skipWs(code, tool.end, end);
        if (code[paren] === "(") {
          repairs.push(...repairCallArgs(code, paren + 1, end, tool.name));
          i = paren + 1;
          continue;
        }
      }
      if (tool) {
        i = tool.end;
        continue;
      }
    }
    i++;
  }
  return repairs;
};

// The property can move inside print only when nobody uses the property's value.
function isDiscardedStatement(node: ts.Expression): boolean {
  let expression: ts.Node = node;
  while (ts.isParenthesizedExpression(expression.parent) || ts.isAwaitExpression(expression.parent)) {
    expression = expression.parent;
  }
  return ts.isExpressionStatement(expression.parent) && expression.parent.expression === expression;
}

// Parse in an async body like the checker: in a script, `await (...)` can parse as a call.
function printedPropertyRepairs(code: string, targets: readonly number[]): Repair[] {
  if (!targets.length) return [];
  const prefix = "export {};\nasync function __fabric_main() {\n";
  const file = ts.createSourceFile("program.ts", prefix + code + "\n}", ts.ScriptTarget.Latest, true);
  const positions = new Set(targets);
  const start = (node: ts.Node): number => node.getStart(file) - prefix.length;
  const end = (node: ts.Node): number => node.end - prefix.length;
  const repairs: Repair[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && !node.questionDotToken && positions.has(start(node.name)) &&
        isDiscardedStatement(node) && ts.isCallExpression(node.expression) && !node.expression.questionDotToken &&
        !node.expression.typeArguments && ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "print" && node.expression.arguments.length === 1) {
      const arg = node.expression.arguments[0]!;
      if (!ts.isSpreadElement(arg)) {
        repairs.push({ start: start(arg), end: start(arg), text: "(" });
        repairs.push({ start: end(arg), end: end(arg), text: ")" + code.slice(end(node.expression), end(node)) });
        repairs.push({ start: end(node.expression), end: end(node), text: "" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return repairs;
}

// Replacing a conditional by a property access must not create a reference-sensitive use.
function referenceSensitiveConditional(node: ts.ConditionalExpression): boolean {
  let expression: ts.Node = node;
  while (ts.isParenthesizedExpression(expression.parent) || ts.isNonNullExpression(expression.parent) ||
         ts.isAsExpression(expression.parent) || ts.isSatisfiesExpression(expression.parent) ||
         ts.isTypeAssertionExpression(expression.parent)) expression = expression.parent;
  const parent = expression.parent;
  return ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === expression) ||
    (ts.isTaggedTemplateExpression(parent) && parent.tag === expression) ||
    ((ts.isTypeOfExpression(parent) || ts.isDeleteExpression(parent)) && parent.expression === expression);
}

// Positions come from the check: TS7053 declarations, unresolved `process`, and missing
// Promise or global print properties. The AST determines which shapes can be repaired.
function diagnosticRepairs(code: string, indexTargets: readonly number[], cwdTargets: readonly number[], cwd?: string, propertyTargets: PropertyTargets = {}): Repair[] {
  if (!indexTargets.length && !cwdTargets.length && !propertyTargets.awaited?.length && !propertyTargets.printed?.length) return [];
  const positions = new Set(indexTargets);
  const cwdPositions = new Set(cwdTargets);
  const awaitPositions = new Set(propertyTargets.awaited);
  const file = ts.createSourceFile("program.ts", code, ts.ScriptTarget.Latest, true);
  const repairs: Repair[] = [];
  const isCwdProperty = (node: ts.Node): boolean =>
    ts.isPropertyAccessExpression(node) && !node.questionDotToken && node.name.getText(file) === "cwd" &&
    ts.isIdentifier(node.expression) && node.expression.text === "process" && cwdPositions.has(node.expression.getStart(file));
  const isCwdCall = (node: ts.Node): boolean => {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    return ts.isCallExpression(node) && !node.typeArguments && node.arguments.length === 0 && isCwdProperty(node.expression);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && positions.has(node.name.getStart(file)) &&
        !node.type && node.initializer && ts.isObjectLiteralExpression(node.initializer) &&
        node.initializer.properties.length === 0 && ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.BlockScoped) !== 0) {
      repairs.push({ start: node.name.end, end: node.name.end, text: ": Record<string, any>" });
    }
    if (cwd !== undefined && ts.isConditionalExpression(node) && isCwdProperty(node.condition) &&
        !referenceSensitiveConditional(node)) {
      // Keep the true branch in place so other diagnosed repairs can still apply inside it.
      repairs.push({ start: node.getStart(file), end: node.whenTrue.getStart(file), text: "(" });
      repairs.push({ start: node.whenTrue.end, end: node.end, text: ")" });
    }
    if (cwd && ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
        isCwdCall(node.left)) {
      // The project folder is non-empty, so neither fallback can be reached.
      repairs.push({ start: node.getStart(file), end: node.end, text: JSON.stringify(cwd) });
      return;
    }
    if (cwd !== undefined && ts.isCallExpression(node) && isCwdCall(node)) {
      // JSON.stringify makes the folder a valid literal even with quotes or backslashes.
      repairs.push({ start: node.getStart(file), end: node.end, text: JSON.stringify(cwd) });
    }
    if (ts.isPropertyAccessExpression(node) && !ts.isPropertyAccessChain(node) && awaitPositions.has(node.name.getStart(file)) &&
        ts.isCallExpression(node.expression) && ts.isAwaitExpression(node.parent) && node.parent.expression === node) {
      repairs.push({ start: node.parent.getStart(file), end: node.parent.getStart(file), text: "(" });
      repairs.push({ start: node.expression.end, end: node.expression.end, text: ")" });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...repairs, ...printedPropertyRepairs(code, propertyTargets.printed ?? [])];
}

function applyRepairs(code: string, repairs: Repair[]): string {
  repairs.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const aInsertion = a.start === a.end;
    const bInsertion = b.start === b.end;
    // Reverse application must replace first, then insert before its start boundary.
    if (aInsertion !== bInsertion) return aInsertion ? -1 : 1;
    return b.end - a.end;
  });
  const disjoint: Repair[] = [];
  for (const repair of repairs) {
    const previous = disjoint.at(-1);
    if (previous && previous.end > previous.start && repair.start < previous.end) {
      // A whole-expression repair discards edits inside it; crossing edits are ambiguous.
      if (repair.end <= previous.end) continue;
      return code;
    }
    disjoint.push(repair);
  }
  let result = code;
  for (let index = disjoint.length - 1; index >= 0; index--) {
    const repair = disjoint[index];
    if (!repair) continue;
    result = result.slice(0, repair.start) + repair.text + result.slice(repair.end);
  }
  return result;
}

/** Returns candidate path and diagnostic-directed repairs. */
export function repairCode(code: string, indexTargets: readonly number[] = [], cwdTargets: readonly number[] = [], cwd?: string): string {
  return applyRepairs(code, [...collectRepairs(code, 0, code.length), ...diagnosticRepairs(code, indexTargets, cwdTargets, cwd)]);
}

// A type mismatch in an object value can be diagnosed on its property name instead of the value.
function diagnosedPropertyPaths(code: string, paths: Repair[], errorPositions: readonly number[]): Set<Repair> {
  const diagnosed = new Set<Repair>();
  if (!paths.length || !errorPositions.length) return diagnosed;
  const file = ts.createSourceFile("program.ts", code, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && errorPositions.some((position) =>
      node.name.getStart(file) <= position && position < node.name.end)) {
      const start = node.initializer.getStart(file);
      for (const path of paths) {
        if (path.start === start && path.end === node.initializer.end) diagnosed.add(path);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return diagnosed;
}

/** Try targeted repairs first; path repairs need a diagnostic at the value or its property name. */
export function repairCandidates(code: string, indexTargets: readonly number[], cwdTargets: readonly number[], cwd: string | undefined, errorPositions: readonly number[], propertyTargets: PropertyTargets = {}): string[] {
  const targeted = diagnosticRepairs(code, indexTargets, cwdTargets, cwd, propertyTargets);
  const scanned = collectRepairs(code, 0, code.length);
  const propertyPaths = diagnosedPropertyPaths(code, scanned, errorPositions);
  const paths = scanned.filter((repair) => propertyPaths.has(repair) ||
    errorPositions.some((position) => repair.start <= position && position < repair.end));
  const candidates = [targeted, paths, [...targeted, ...paths]]
    .map((repairs) => applyRepairs(code, repairs));
  return [...new Set(candidates)].filter((candidate) => candidate !== code);
}
