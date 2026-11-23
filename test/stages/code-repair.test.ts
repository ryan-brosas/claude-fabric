import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { check } from "../../src/kernel/check.ts";
import { checkProgram, run } from "../../src/kernel/host.ts";
import { TOOLS } from "../../src/providers/tools/index.ts";
import { guestTypes } from "../../src/registry/generate.ts";
import { repairCandidates, repairCode } from "../../src/stages/code-repair.ts";

const declarations = guestTypes(TOOLS);
const PROJECT = "/fixture/project";

test("repairs a missing object brace at the end of a call", () => {
  const code = 'await Read({file_path: "a.txt");';
  const original = check(code, declarations);
  expect(original.errors).toEqual(["line 1:31 ',' expected."]);
  const result = checkProgram(code, { cwd: PROJECT });
  expect(result.checked.ok).toBe(true);
  expect(result.program).toBe('await Read({file_path: "a.txt"});');
});

test("leaves a nested missing object brace alone when one insertion cannot close the call argument", () => {
  const code = 'function f(x: {a: {b: number}}) {} f({a: {b: 1);';
  const original = check(code, declarations);
  expect(original.ok).toBe(false);
  expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
});

test("repairs an outer call argument with a closed nested object", () => {
  const code = 'function f(x: {a: {b: number}}) {} f({a: {b: 1});';
  const result = checkProgram(code, { cwd: PROJECT });
  expect(result.checked.ok).toBe(true);
  expect(result.program).toBe('function f(x: {a: {b: number}}) {} f({a: {b: 1}});');
});

test("does not repair a comma error without an object argument", () => {
  const code = 'function f(a: number, b: number) {} f(1 2);';
  const original = check(code, declarations);
  expect(original.errors).toContain("line 1:41 ',' expected.");
  expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
});

test("keeps the original errors if a brace repair leaves a type error", () => {
  const code = 'await Read({file_path: "a.txt"); const n: number = "bad";';
  const original = check(code, declarations);
  expect(original.errors).toContain("line 1:31 ',' expected.");
  expect(original.errors.join("\n")).toContain("Type 'string' is not assignable to type 'number'");
  expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
});

test("only repairs a directly diagnosed call-argument brace", () => {
  const cases = [
    'const x = { a: { b: 1 );',
    'new F({a: 1);',
    'f(({a: 1));',
    'f({a: 1}, 2);',
    'f({a: 1});',
  ];
  for (const code of cases) {
    const position = code.indexOf(")");
    expect(repairCandidates(code, [], [], undefined, [position], {}, [position])).toEqual([]);
  }
});

test("inserts braces only at diagnosed positions and can repair multiple calls", () => {
  const code = 'await Read({file_path:"a"); await Read({file_path:"b");';
  const original = check(code, declarations);
  const first = code.indexOf(")");
  const second = code.lastIndexOf(")");
  expect(original.braceTargets).toEqual([first, second]);
  expect(repairCandidates(code, [], [], undefined, original.errorPositions ?? [], {}, [first]))
    .toEqual(['await Read({file_path:"a"}); await Read({file_path:"b");']);
  expect(repairCandidates(code, [], [], undefined, original.errorPositions ?? [], {}, [first - 1])).toEqual([]);
  const result = checkProgram(code, { cwd: PROJECT });
  expect(result.checked.ok).toBe(true);
  expect(result.program).toBe('await Read({file_path:"a"}); await Read({file_path:"b"});');
});

test("runs a repaired Read but never executes a candidate with other errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-brace-"));
  try {
    await Bun.write(join(dir, "a.txt"), "brace repair content");
    const passed = await run('return await Read({file_path: "a.txt");', dir);
    expect(passed.ok).toBe(true);
    expect(passed.calls).toBe(1);
    expect(passed.text).toContain("brace repair content");

    const code = 'await Write({file_path: "never", content: "x"); const n: number = "bad";';
    const original = check(code, declarations);
    const failed = await run(code, dir);
    expect(failed.ok).toBe(false);
    expect(failed.calls).toBe(0);
    for (const error of original.errors) expect(failed.text).toContain(error);
    expect(await Bun.file(join(dir, "never")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repairs a property accessed before awaiting a call", () => {
  const code = 'print(await Bash({command: "pwd"}).output);';
  const result = checkProgram(code, { cwd: PROJECT });
  expect(result.checked.ok).toBe(true);
  expect(result.program).toBe('print((await Bash({command: "pwd"})).output);');
});

test("moves a property on the global print result to its argument", () => {
  const code = 'print(await Bash({command: "pwd"})).output;';
  const result = checkProgram(code, { cwd: PROJECT });
  expect(result.checked.ok).toBe(true);
  expect(result.program).toBe('print((await Bash({command: "pwd"})).output);');
});

test("refuses to move a print property whose value is assigned and written", () => {
  const code = 'const output = print(await Bash({command:"printf data"})).output;\nawait Write("answer.txt", `output=${output}`);';
  const original = check(code, declarations);
  expect(original.ok).toBe(false);
  expect(original.errors.join("\n")).toContain("Property 'output' does not exist on type 'void'");
  const result = checkProgram(code, { cwd: PROJECT });
  expect(result.checked.ok).toBe(false);
  expect(result.program).toBe(code);
  expect(result.checked.errors).toEqual(original.errors);
});

test("repairs discarded print properties in statements with await or parentheses", () => {
  const cases = [
    ['print(await Bash({command:"printf data"})).output; return 1;', 'print((await Bash({command:"printf data"})).output); return 1;'],
    ['(print(await Bash({command:"printf data"})).output)', '(print((await Bash({command:"printf data"})).output))'],
    ['await ((print(await Bash({command:"printf data"})).output)); return 1;', 'await ((print((await Bash({command:"printf data"})).output))); return 1;'],
    ['await print(await Bash({command:"printf data"})).output;', 'await print((await Bash({command:"printf data"})).output);'],
    ['if (true) { (await (print(await Bash({command:"printf data"})).output)); } return 1;', 'if (true) { (await (print((await Bash({command:"printf data"})).output))); } return 1;'],
  ] as const;
  for (const [code, expected] of cases) {
    const result = checkProgram(code, { cwd: PROJECT });
    expect(result.checked.ok).toBe(true);
    expect(result.program).toBe(expected);
  }
});

test("refuses print properties used in expressions, including wrapped ones", () => {
  const access = 'print(await Bash({command:"printf data"})).output';
  for (const code of [
    `return ${access};`,
    `return await ((${access}));`,
    `String(${access});`,
    `const text = \`output=\${${access}}\`;`,
    `if (${access}) print("yes");`,
    `let value: unknown; value = ${access};`,
    `const fn = async () => ${access};`,
    `${access}, print("after");`,
    `await (${access} + "suffix");`,
    `void ${access};`,
    `for (${access}; false;) {}`,
    `${access}; const used = ${access};`,
  ]) {
    const original = check(code, declarations);
    expect(original.ok).toBe(false);
    expect(original.errors.join("\n")).toContain("Property 'output' does not exist on type 'void'");
    expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
  }
});

test("a consumed print property prevents all tool calls and writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-print-refused-"));
  try {
    const code = 'const output = print(await Bash({command:"printf data"})).output;\nawait Write("answer.txt", `output=${output}`);';
    const result = await run(code, dir);
    expect(result.ok).toBe(false);
    expect(result.calls).toBe(0);
    expect(result.text).toContain("Property 'output' does not exist on type 'void'");
    expect(await Bun.file(join(dir, "answer.txt")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repairs a guarded cwd property alongside an accumulator", () => {
  const code = 'const out = {}; for (const f of ["a"]) out[f] = process.cwd ? `${process.cwd()}/${f}` : f; return out;';
  const result = checkProgram(code, { cwd: PROJECT });
  expect(result.checked.ok).toBe(true);
  expect(result.program).toBe('const out: Record<string, any> = {}; for (const f of ["a"]) out[f] = (`${"/fixture/project"}/${f}`); return out;');
});

test("repairs an unresolved optional cwd call", () => {
  const code = 'return process.cwd?.();';
  const result = checkProgram(code, { cwd: PROJECT });
  expect(result.checked.ok).toBe(true);
  expect(result.program).toBe('return "/fixture/project";');
});

test("repairs cwd calls as conditions and repairs the retained branch", () => {
  for (const condition of ["process.cwd()", "process.cwd?.()", "((process.cwd()))", "((process.cwd?.()))"]) {
    const code = `return ${condition} ? process.cwd?.() + "/a" : "fallback";`;
    const result = checkProgram(code, { cwd: PROJECT });
    expect(result.checked.ok).toBe(true);
    expect(result.program).toBe('return ("/fixture/project" + "/a");');
  }
});

test("refuses guarded conditionals in reference-sensitive positions", async () => {
  const code = 'const obj = { value: "ok", f() { return this.value; } }; await Write("never", "x"); return ((process.cwd ? obj.f : obj.f))();';
  const original = check(code, declarations);
  expect(original.ok).toBe(false);
  expect(original.cwdTargets).toHaveLength(1);
  expect(repairCode(code, original.indexTargets, original.cwdTargets, PROJECT)).toBe(code);
  expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
  const dir = await mkdtemp(join(tmpdir(), "fabric-cwd-reference-"));
  try {
    const result = await run(code, dir);
    expect(result.ok).toBe(false);
    expect(result.calls).toBe(0);
    expect(result.ms.run).toBe(0);
    for (const error of original.errors) expect(result.text).toContain(error);
    expect(await Bun.file(join(dir, "never")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  for (const expression of [
    'new ((process.cwd ? obj.C : obj.C))()',
    '((process.cwd ? obj.tag : obj.tag))`text`',
    'typeof ((process.cwd ? obj.value : obj.value))',
    'delete ((process.cwd ? obj.value : obj.value))',
    'new ((process.cwd ? obj.C : obj.C)!)()',
    '((process.cwd ? obj.tag : obj.tag) as (s: TemplateStringsArray) => string)`text`',
    'typeof ((process.cwd ? obj.value : obj.value) satisfies string | undefined)',
    'delete ((process.cwd ? obj.value : obj.value) as string | undefined)',
  ]) {
    const program = `const obj: { value?: string; C: new () => object; tag: (s: TemplateStringsArray) => string } = { C: class {}, tag: s => s[0] ?? "" }; return ${expression};`;
    const checked = check(program, declarations);
    expect(checked.ok).toBe(false);
    expect(checked.cwdTargets).toHaveLength(1);
    expect(repairCode(program, checked.indexTargets, checked.cwdTargets, PROJECT)).toBe(program);
    expect(checkProgram(program, { cwd: PROJECT })).toEqual({ program, checked });
  }
});

for (const [wrapper, expression] of [
  ["non-null", '(process.cwd ? obj.f : obj.f)!()'],
  ["as", '((process.cwd ? obj.f : obj.f) as () => string)()'],
  ["satisfies", '((process.cwd ? obj.f : obj.f) satisfies () => string)()'],
  ["type assertion", '(<() => string>(process.cwd ? obj.f : obj.f))()'],
  ["mixed wrappers", '(((process.cwd ? obj.f : obj.f)! as () => string) satisfies () => string)()'],
] as const) {
  test(`refuses a ${wrapper} wrapped conditional callee`, () => {
    const code = `const obj = { value: "ok", f() { return this.value; } }; return ${expression};`;
    const original = check(code, declarations);
    expect(original.ok).toBe(false);
    expect(original.cwdTargets).toHaveLength(1);
    expect(original.errors.join("\n")).toContain("Cannot find name 'process'");
    expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
  });
}

test("refuses cwd call conditions in reference-sensitive positions", async () => {
  for (const condition of ["process.cwd()", "process.cwd?.()", "((process.cwd()))", "((process.cwd?.()))"]) {
    for (const expression of [
      `((${condition} ? obj.f : obj.f))()`,
      `new ((${condition} ? obj.C : obj.C)!)()`,
      `((${condition} ? obj.tag : obj.tag) as (s: TemplateStringsArray) => string)\`text\``,
      `typeof ((${condition} ? obj.value : obj.value) satisfies string | undefined)`,
      `delete ((${condition} ? obj.value : obj.value) as string | undefined)`,
      `((((${condition} ? obj.f : obj.f)! as () => string) satisfies () => string))()`,
    ]) {
      const code = `const obj: { value?: string; f: () => string; C: new () => object; tag: (s: TemplateStringsArray) => string } = { f: () => "ok", C: class {}, tag: s => s[0] ?? "" }; return ${expression};`;
      const original = check(code, declarations);
      expect(original.cwdTargets).toHaveLength(1);
      expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "fabric-cwd-call-reference-"));
  try {
    for (const condition of ["process.cwd()", "process.cwd?.()"]) {
      const code = `const obj = { value: "ok", f() { return this.value; } }; await Write("never", "x"); return ((${condition} ? obj.f : obj.f))();`;
      const original = check(code, declarations);
      const result = await run(code, dir);
      expect(result.ok).toBe(false);
      expect(result.calls).toBe(0);
      expect(result.ms.run).toBe(0);
      for (const error of original.errors) expect(result.text).toContain(error);
      expect(await Bun.file(join(dir, "never")).exists()).toBe(false);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses a generic instantiation of a guarded method", async () => {
  const code = 'const obj = { value: "bound", f<T>() { return this.value; } }; await Write("never", "x"); return ((process.cwd() ? obj.f : obj.f)<string>)();';
  const original = check(code, declarations);
  expect(original.ok).toBe(false);
  expect(original.errors.join("\n")).toContain("Cannot find name 'process'");
  expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
  const dir = await mkdtemp(join(tmpdir(), "fabric-cwd-generic-"));
  try {
    const result = await run(code, dir);
    expect(result.ok).toBe(false);
    expect(result.calls).toBe(0);
    for (const error of original.errors) expect(result.text).toContain(error);
    expect(await Bun.file(join(dir, "never")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses a guarded anonymous function whose inferred name would change", async () => {
  const code = 'const f = process.cwd() ? () => 1 : () => 2; return f.name;';
  const original = check(code, declarations);
  expect(original.ok).toBe(false);
  expect(original.errors.join("\n")).toContain("Cannot find name 'process'");
  expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
  const dir = await mkdtemp(join(tmpdir(), "fabric-cwd-name-"));
  try {
    const result = await run(code, dir);
    expect(result.ok).toBe(false);
    expect(result.calls).toBe(0);
    for (const error of original.errors) expect(result.text).toContain(error);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses a property true branch even when the conditional is used as a value", () => {
  const code = 'const obj = { f() { return "ok"; } }; const fn = (process.cwd ? obj.f : obj.f) as () => string; return fn();';
  const original = check(code, declarations);
  expect(original.ok).toBe(false);
  expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
});

test("refuses a guarded eval callee without changing its original errors or running tools", async () => {
  const code = 'const x = 42; await Write("never", "x"); return (process.cwd ? eval : eval)("typeof x");';
  const original = check(code, declarations);
  expect(original.ok).toBe(false);
  expect(original.errors.join("\n")).toContain("Cannot find name 'process'");
  expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
  const dir = await mkdtemp(join(tmpdir(), "fabric-cwd-eval-"));
  try {
    const result = await run(code, dir);
    expect(result.ok).toBe(false);
    expect(result.calls).toBe(0);
    expect(result.ms.run).toBe(0);
    for (const error of original.errors) expect(result.text).toContain(error);
    expect(await Bun.file(join(dir, "never")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses identifier true branches through transparent wrappers", () => {
  for (const branch of [
    'someVar', '(someVar)', '(someVar!)', '(someVar as string)',
    '(someVar satisfies string)', '(<string>someVar)',
    '(((someVar!) as string) satisfies string)',
  ]) {
    for (const condition of ['process.cwd', 'process.cwd()', 'process.cwd?.()']) {
      const code = `const someVar = "y"; return ${condition} ? ${branch} : "x";`;
      const original = check(code, declarations);
      expect(original.ok).toBe(false);
      expect(original.errors).toHaveLength(1);
      expect(original.errors.join("\n")).toContain("Cannot find name 'process'");
      expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
    }
  }
  const code = 'function someVar<T>() { return 1; } return process.cwd ? someVar<string> : someVar<string>;';
  const original = check(code, declarations);
  expect(original.ok).toBe(false);
  expect(original.errors).toHaveLength(1);
  expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
});

test("refuses property and element true branches through transparent wrappers", () => {
  for (const branch of [
    'obj.f', 'obj["f"]', 'obj?.f', 'obj?.["f"]', '(obj.f)', '(obj.f!)',
    '(obj.f as typeof obj.f)', '(obj.f satisfies typeof obj.f)',
    '(<typeof obj.f>obj.f)', '(obj.f<string>)', '(((obj["f"]!) as typeof obj.f) satisfies typeof obj.f)',
  ]) {
    for (const condition of ['process.cwd', 'process.cwd()', 'process.cwd?.()']) {
      const code = `const obj = { f<T>() { return "ok"; } }; const value = ${condition} ? ${branch} : ${branch}; return value;`;
      const original = check(code, declarations);
      expect(original.ok).toBe(false);
      expect(original.errors).toHaveLength(1);
      expect(original.errors.join("\n")).toContain("Cannot find name 'process'");
      expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
    }
  }
});

test("refuses function and class true branches through transparent wrappers", () => {
  for (const branch of [
    '() => 1', '(function () { return 1; })', '(class {})',
    '(function named() { return 1; })', '(class Named {})',
    '((() => 1) as () => number)', '((() => 1) satisfies () => number)',
    '(<() => number>(() => 1))', '((() => 1)!)',
  ]) {
    for (const condition of ['process.cwd', 'process.cwd()', 'process.cwd?.()']) {
      const code = `const value = ${condition} ? ${branch} : ${branch}; return value.name;`;
      const original = check(code, declarations);
      expect(original.ok).toBe(false);
      expect(original.errors).toHaveLength(1);
      expect(original.errors.join("\n")).toContain("Cannot find name 'process'");
      expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
    }
  }
});

test("repairs guarded template, concatenation, call, and await values", () => {
  for (const condition of ['process.cwd', 'process.cwd()', 'process.cwd?.()']) {
    for (const [branch, expected] of [
      ['`path/${process.cwd()}`', '`path/${"/fixture/project"}`'],
      ['process.cwd() + "/a"', '"/fixture/project" + "/a"'],
      ['String("ok")', 'String("ok")'],
      ['await Promise.resolve("ok")', 'await Promise.resolve("ok")'],
    ]) {
      const code = `async function value() { return ${condition} ? ${branch} : "fallback"; } return value();`;
      const result = checkProgram(code, { cwd: PROJECT });
      expect(result.checked.ok).toBe(true);
      expect(result.program).toBe(`async function value() { return (${expected}); } return value();`);
    }
  }
});

test("repairs a call-result true branch even in a conditional callee", () => {
  const code = 'const make = () => () => "ok"; return (process.cwd ? make() : make())();';
  const result = checkProgram(code, { cwd: PROJECT });
  expect(result.checked.ok).toBe(true);
  expect(result.program).toBe('const make = () => () => "ok"; return ((make()))();');
});

test("runs repaired guarded values without evaluating their fallbacks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-cwd-values-"));
  try {
    for (const [code, expected] of [
      ['return process.cwd ? `dir:${process.cwd()}` : (await Write("never", "x"), "fallback");', `dir:${dir}`],
      ['return process.cwd() ? process.cwd() + "/a" : (await Write("never", "x"), "fallback");', `${dir}/a`],
      ['return process.cwd?.() ? String("call") : (await Write("never", "x"), "fallback");', 'call'],
      ['return process.cwd ? await Promise.resolve("await") : (await Write("never", "x"), "fallback");', 'await'],
      ['const make = () => () => "callee"; return (process.cwd ? make() : make())();', 'callee'],
    ]) {
      const result = await run(code, dir);
      expect(result.ok).toBe(true);
      expect(result.text).toBe(expected);
      expect(result.calls).toBe(0);
      expect(await Bun.file(join(dir, "never")).exists()).toBe(false);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("composes cwd fallback replacements with boundary insertions", () => {
  for (const call of ["process.cwd()", "process.cwd?.()"]) {
    for (const operator of ["||", "??"]) {
      const code = `print(${call} ${operator} ".").length;`;
      const result = checkProgram(code, { cwd: PROJECT });
      expect(result.checked.ok).toBe(true);
      expect(result.program).toBe('print(("/fixture/project").length);');
    }
  }
  const inside = 'return process.cwd() || (() => { print("x").length; return "."; })();';
  const checked = check(inside, declarations);
  expect(checked.cwdTargets).toHaveLength(1);
  expect(checked.printPropertyTargets).toHaveLength(1);
  expect(checkProgram(inside, { cwd: PROJECT })).toMatchObject({
    program: 'return "/fixture/project";', checked: { ok: true },
  });
});

test("repairs cwd calls on the left of nullish and logical fallbacks", () => {
  for (const call of ["process.cwd()", "process.cwd?.()", "(process.cwd())", "(process.cwd?.())"]) {
    for (const operator of ["??", "||"]) {
      const code = `return ${call} ${operator} ".";`;
      const result = checkProgram(code, { cwd: PROJECT });
      expect(result.checked.ok).toBe(true);
      expect(result.program).toBe('return "/fixture/project";');
    }
  }
});

test("runs synthetic guarded programs without their unreachable fallbacks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-cwd-guard-"));
  try {
    for (const code of [
      'return process.cwd?.() || (await Write("never", "x"), ".");',
      'return process.cwd ? process.cwd() + "/a" : (await Write("never", "x"), ".");',
      'return process.cwd() ? process.cwd() + "/a" : (await Write("never", "x"), ".");',
      'return (process.cwd?.()) ? process.cwd() + "/a" : (await Write("never", "x"), ".");',
    ]) {
      const result = await run(code, dir);
      expect(result.ok).toBe(true);
      expect(result.text).toBe(code.includes(" ? ") ? dir + "/a" : dir);
      expect(result.calls).toBe(0);
      expect(await Bun.file(join(dir, "never")).exists()).toBe(false);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("combines nested guard repairs and discards repairs in an unreachable branch", () => {
  const code = 'return process.cwd ? process.cwd?.() ?? "." : process.cwd();';
  const result = checkProgram(code, { cwd: PROJECT });
  expect(result.checked.ok).toBe(true);
  expect(result.program).toBe('return ("/fixture/project");');
  const nested = 'return process.cwd?.() ? process.cwd() ? process.cwd() : "inner" : "outer";';
  expect(checkProgram(nested, { cwd: PROJECT })).toMatchObject({
    program: 'return (("/fixture/project"));', checked: { ok: true },
  });
  const boundary = 'print(process.cwd() ? "x" : "y").length;';
  expect(checkProgram(boundary, { cwd: PROJECT })).toMatchObject({
    program: 'print((("x")).length);', checked: { ok: true },
  });
  const fallback = 'return process.cwd() || Read(/tmp/x);';
  expect(checkProgram(fallback, { cwd: PROJECT })).toMatchObject({
    program: 'return "/fixture/project";', checked: { ok: true },
  });
});

test("keeps the original errors when a guarded true branch still fails", async () => {
  const code = 'await Write("never", "x"); return process.cwd ? missing() : "fallback";';
  const original = check(code, declarations);
  const repaired = repairCode(code, original.indexTargets, original.cwdTargets, PROJECT);
  expect(repaired).toBe('await Write("never", "x"); return (missing());');
  expect(check(repaired, declarations).ok).toBe(false);
  expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
  const dir = await mkdtemp(join(tmpdir(), "fabric-cwd-rejected-"));
  try {
    const result = await run(code, dir);
    expect(result.ok).toBe(false);
    expect(result.calls).toBe(0);
    expect(result.ms.run).toBe(0);
    for (const error of original.errors) expect(result.text).toContain(error);
    expect(await Bun.file(join(dir, "never")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not widen guard repairs to other process shapes", () => {
  for (const code of [
    'return process.cwd("arg") ? "a" : "b";',
    'return process.cwd<string>() ? "a" : "b";',
    'return process?.cwd() ? "a" : "b";',
    'return process.env.X ?? "y";',
    'return process ? "a" : "b";',
    'return typeof process !== "undefined" ? "a" : "b";',
  ]) {
    const original = check(code, declarations);
    if (code.includes("process.env")) {
      expect(repairCode(code, original.indexTargets, original.cwdTargets, PROJECT)).toBe(code);
    }
    expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
  }
});

test("leaves a scoped process guard untouched while repairing another error", () => {
  const code = 'const process: { cwd?: () => string } = {}; const out = {}; for (const k of ["a"]) out[k] = process.cwd ? process.cwd() : "local"; return out;';
  const result = checkProgram(code, { cwd: PROJECT });
  expect(result.checked.ok).toBe(true);
  expect(result.program).toBe(code.replace("out = {}", "out: Record<string, any> = {}"));
  for (const call of ["process.cwd()", "process.cwd?.()", "((process.cwd()))", "((process.cwd?.()))"]) {
    const local = `const process = { cwd: () => "" }; const out = {}; for (const k of ["a"]) out[k] = ${call} ? "cwd" : "local"; return out;`;
    const repaired = checkProgram(local, { cwd: PROJECT });
    expect(repaired.checked.ok).toBe(true);
    expect(repaired.program).toBe(local.replace("out = {}", "out: Record<string, any> = {}"));
  }
  const passing = 'const process = { cwd: () => null as string | null }; return process.cwd() ?? "local";';
  expect(check(passing, declarations).ok).toBe(true);
  expect(checkProgram(passing, { cwd: PROJECT }).program).toBe(passing);
});

test("runs each repaired property access exactly once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-await-"));
  try {
    for (const code of [
      'print(await Bash({command: "printf result"}).output);',
      'print(await Bash({command: "printf result"})).output;',
      'await ((print(await Bash({command: "printf result"})).output));',
    ]) {
      const result = await run(code, dir);
      expect(result.ok).toBe(true);
      expect(result.calls).toBe(1);
      expect(result.text).toBe("result");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a bad property and an await of a non-call retain their original errors", () => {
  for (const code of [
    'return await Bash({command: "pwd"}).missing;',
    'const promise = Bash({command: "pwd"}); return await promise.output;',
    'print(await Bash({command: "pwd"})).missing;',
    'return await Bash({command: "pwd"})?.output;',
  ]) {
    const original = check(code, declarations);
    expect(original.ok).toBe(false);
    expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
  }
});

test("a candidate that still fails does not run any program tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-await-rejected-"));
  try {
    const code = 'await Write("never", "x"); return await Bash({command: "pwd"}).missing;';
    const result = await run(code, dir);
    expect(result.ok).toBe(false);
    expect(result.calls).toBe(0);
    expect(result.text).toContain("Property 'missing' does not exist on type 'Promise<BashResult>'");
    expect(await Bun.file(join(dir, "never")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("never repairs a shadowed or rebound print, eval, or two print arguments", () => {
  for (const code of [
    'function print(value: { output: string }): void {} print({output: "x"}).output;',
    'const print = (value: { output: string }): void => {}; print({output: "x"}).output;',
    'print({output: "x"}, "second").output;',
    '// @ts-ignore\nprint = () => ({output: "replacement"});\nreturn print({output: "argument"}).output;',
    'eval(\'print = () => ({output: "replacement"})\'); return print({output: "argument"}).output;',
  ]) {
    const original = check(code, declarations);
    expect(original.ok).toBe(false);
    expect(checkProgram(code, { cwd: PROJECT })).toEqual({ program: code, checked: original });
  }
});

test("does not touch property-shaped text or an undiagnosed access", () => {
  const code = 'const s = "await Bash(x).output"; const t = `print({output: 1}).output`; print(await Bash({command: "pwd"}).output); return [s, t];';
  const result = checkProgram(code, { cwd: PROJECT });
  expect(result.checked.ok).toBe(true);
  expect(result.program).toBe('const s = "await Bash(x).output"; const t = `print({output: 1}).output`; print((await Bash({command: "pwd"})).output); return [s, t];');
  const invalid = 'const p = Promise.resolve({output: "ok"}); return await p.output;';
  expect(checkProgram(invalid, { cwd: PROJECT }).program).toBe(invalid);
});

test("leaves passing property accesses and optional cwd calls unchanged", () => {
  for (const code of [
    'print((await Bash({command: "pwd"})).output);',
    'const process = { cwd: () => "local" }; return process.cwd?.();',
    'const print = (x: unknown) => ({output: x}); return print("x").output;',
  ]) {
    expect(check(code, declarations).ok).toBe(true);
    expect(checkProgram(code, { cwd: PROJECT }).program).toBe(code);
  }
});

test("combines diagnostic repairs in a single program", () => {
  const code = 'print(await Bash({command: process.cwd?.()})).output;';
  const result = checkProgram(code, { cwd: PROJECT });
  expect(result.checked.ok).toBe(true);
  expect(result.program).toBe('print((await Bash({command: "/fixture/project"})).output);');
});

test("combines multiple property and path repairs without changing neighboring text", () => {
  const code = 'const a = await Bash({command: "pwd"}).output; print(await Bash({command: "pwd"})).exitCode; return [a, await Read(/tmp/x)];';
  const result = checkProgram(code, { cwd: PROJECT });
  expect(result.checked.ok).toBe(true);
  expect(result.program).toBe('const a = (await Bash({command: "pwd"})).output; print((await Bash({command: "pwd"})).exitCode); return [a, await Read("/tmp/x")];');
});

test("the host repairs a regex-shaped object path diagnosed at the property name", () => {
  const code = 'return await Read({ file_path: /tmp/i });';
  const checked = check(code, declarations);
  expect(checked.errorPositions).toContain(code.indexOf("file_path"));
  const result = checkProgram(code, { cwd: PROJECT });
  expect(result.checked.ok).toBe(true);
  expect(result.program).toBe('return await Read({ file_path: "/tmp/i" });');
});

test("the host repairs regex-shaped object paths for all path tools", () => {
  const cases = [
    ['return await Read({ "file_path": /tmp/i });', 'return await Read({ "file_path": "/tmp/i" });'],
    ['return await Write({ file_path: /tmp/i, content: "x" });', 'return await Write({ file_path: "/tmp/i", content: "x" });'],
    ['return await Edit({ file_path: /tmp/i, old_string: "a", new_string: "b" });', 'return await Edit({ file_path: "/tmp/i", old_string: "a", new_string: "b" });'],
    ['return await Grep({ pattern: "x", path: /tmp/i });', 'return await Grep({ pattern: "x", path: "/tmp/i" });'],
    ['return await Glob({ pattern: "*.ts", path: /tmp/i });', 'return await Glob({ pattern: "*.ts", path: "/tmp/i" });'],
  ] as const;
  for (const [code, expected] of cases) {
    const result = checkProgram(code, { cwd: PROJECT });
    expect({ code, ok: result.checked.ok, program: result.program }).toEqual({ code, ok: true, program: expected });
  }
});

test("a positional regex-shaped path is diagnosed at its value and repaired", () => {
  const code = 'return await Read(/tmp/i);';
  expect(check(code, declarations).errorPositions).toContain(code.indexOf('/tmp/i'));
  expect(checkProgram(code, { cwd: PROJECT })).toMatchObject({
    program: 'return await Read("/tmp/i");', checked: { ok: true },
  });
});

test("property-name diagnostics only authorize their exact initializer", () => {
  const sibling = 'return await Read({ file_path: /tmp/.source, offset: "bad" });';
  expect(check(sibling, declarations).errorPositions).toContain(sibling.indexOf("offset"));
  expect(repairCandidates(sibling, [], [], undefined, [sibling.indexOf("offset")])).toEqual([]);
  const expression = 'return await Read({ file_path: /tmp/i + ".x" });';
  expect(repairCode(expression)).not.toBe(expression);
  expect(repairCandidates(expression, [], [], undefined, [expression.indexOf("file_path")])).toEqual([]);
});

test("diagnostic repairs preserve valid regex-source paths", () => {
  const objectCode = 'await Write({ file_path: /tmp/.source, content: "x" }); return process.cwd();';
  const objectResult = checkProgram(objectCode, { cwd: PROJECT });
  expect(objectResult.checked.ok).toBe(true);
  expect(objectResult.program).toContain('file_path: /tmp/.source');
  for (const suffix of ['return process.cwd();', 'const out = {}; for (const k of ["x"]) out[k] = k; return out;']) {
    const code = 'await Write(/tmp/.source, "x"); ' + suffix;
    const result = checkProgram(code, { cwd: PROJECT });
    expect(result.checked.ok).toBe(true);
    expect(result.program).toContain('Write(/tmp/.source, "x")');
  }
});

test("mixed diagnostics repair only the invalid path and preserve regex source", () => {
  const code = 'await Write(/tmp/.source, "x"); await Write(/tmp/x, "y"); return process.cwd();';
  const result = checkProgram(code, { cwd: PROJECT });
  expect(result.checked.ok).toBe(true);
  expect(result.program).toContain('Write(/tmp/.source, "x")');
  expect(result.program).toContain('Write("/tmp/x", "y")');
  expect(result.program).toContain('return "/fixture/project"');
});

test("diagnostic-only repair writes the regex source inside the project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-regexp-"));
  try {
    const code = 'await Write(/tmp/.source, "x"); return process.cwd();';
    // Refuse to execute if a regression would turn the path into an absolute write.
    expect(checkProgram(code, { cwd: dir }).program).toContain('Write(/tmp/.source, "x")');
    const result = await run(code, dir);
    expect(result.ok).toBe(true);
    expect(await Bun.file(join(dir, "tmp")).text()).toBe("x");
    expect(result.text).toBe(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read-only indexed lookups do not turn a rejected program into side effects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-read-only-"));
  try {
    const marker = join(dir, "marker");
    await Bun.write(marker, "unchanged");
    const result = await run('const out = {}; await Write("marker", "changed"); return out["missing"]();', dir);
    expect(result.ok).toBe(false);
    expect(result.calls).toBe(0);
    expect(await Bun.file(marker).text()).toBe("unchanged");
    expect(result.text).toContain("Type errors; code was not executed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("returns the absolute project folder for an unresolved process.cwd call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-cwd-"));
  try {
    const result = await run("return process.cwd();", dir);
    expect(result.ok).toBe(true);
    expect(result.text).toBe(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a relative run folder still repairs cwd to an absolute project path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-cwd-"));
  try {
    const result = await run("return process.cwd();", relative(process.cwd(), dir));
    expect(result.ok).toBe(true);
    expect(result.text).toBe(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repairs process.cwd in a Write path and creates the file in the project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-cwd-"));
  try {
    const code = 'await Write({file_path: process.cwd()+"/ANSWER.md", content: "answer"}); return "ok"';
    const result = await run(code, dir);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("ok");
    expect(result.calls).toBe(1);
    expect(await Bun.file(join(dir, "ANSWER.md")).text()).toBe("answer");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repairs a cwd template in a Bash command running from the project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric cwd "));
  try {
    const code = 'const r = await Bash({command: `cd "${process.cwd()}" && pwd`}); return r.output;';
    const result = await run(code, dir);
    expect(result.ok).toBe(true);
    expect(result.calls).toBe(1);
    expect(result.text.trim()).toBe(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cwd in a Bash command stays absolute after the shell changes directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-cwd-"));
  try {
    const code = 'return (await Bash({command: "cd /; cd " + process.cwd() + "; pwd"})).output;';
    const result = await run(code, dir);
    expect(result.ok).toBe(true);
    expect(result.text.trim()).toBe(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("folder names with spaces, double quotes and backslashes form valid literals", async () => {
  for (const prefix of ["fabric space ", 'fabric "quote\\backslash-']) {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    try {
      const code = 'await Write({file_path: process.cwd() + "/ANSWER.md", content: "ok"}); return process.cwd();';
      const result = await run(code, dir);
      expect(result.ok).toBe(true);
      expect(result.text).toBe(dir);
      expect(await Bun.file(join(dir, "ANSWER.md")).text()).toBe("ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("does not repair cwd without a project folder", () => {
  const code = "return process.cwd();";
  const checked = check(code, declarations);
  expect(checked.ok).toBe(false);
  expect(repairCode(code, checked.indexTargets, checked.cwdTargets)).toBe(code);
  expect(checkProgram(code)).toMatchObject({ program: code, checked: { ok: false } });
  expect(checkProgram(code).checked.errors.join("\n")).toContain("Cannot find name \'process\'");
  for (const condition of ["process.cwd()", "process.cwd?.()"]) {
    const guarded = `return ${condition} ? "a" : "b";`;
    const original = check(guarded, declarations);
    expect(repairCode(guarded, original.indexTargets, original.cwdTargets)).toBe(guarded);
    expect(checkProgram(guarded)).toEqual({ program: guarded, checked: original });
    expect(repairCode(guarded, original.indexTargets, original.cwdTargets, ""))
      .toBe('return "" ? "a" : "b";');
  }
});

test("repairs an empty object accumulator rejected by the check", async () => {
  const code = 'const out = {}; for (const f of ["a", "b"]) out[f] = f; return out;';
  expect(check(code, declarations).ok).toBe(false);
  const result = await run(code, tmpdir());
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.text)).toEqual({ a: "a", b: "b" });
});

const candidate = (code: string): string => {
  const checked = check(code, declarations);
  return repairCode(code, checked.indexTargets, checked.cwdTargets, PROJECT);
};

test("repairs only the diagnostic-targeted cwd call in concatenation and template expressions", () => {
  const code = 'const s = "process.cwd()"; const t = `process.cwd()`; // process.cwd()\nreturn [process.cwd() + "/a", `${process.cwd()}/b`, s, t];';
  expect(candidate(code)).toBe('const s = "process.cwd()"; const t = `process.cwd()`; // process.cwd()\nreturn ["/fixture/project" + "/a", `${"/fixture/project"}/b`, s, t];');
  expect(checkProgram(code, { cwd: PROJECT }).checked.ok).toBe(true);
});

test("refuses other process properties, non-exact calls, and text", () => {
  for (const expression of ["process.env.X", "process.argv", "process.exit()", "process.cwd", "process.cwd(1)", "process.cwd<string>()", "process?.cwd()", 'process["cwd"]()', "process.c\\u0077d()", "other.process.cwd()"]) {
    const code = `return ${expression};`;
    expect(check(code, declarations).ok).toBe(false);
    expect(candidate(code)).toBe(code);
    expect(checkProgram(code).checked.ok).toBe(false);
  }
  const text = 'const s = "process.cwd()"; const t = `process.cwd()`; // process.cwd()\nreturn missing;';
  expect(candidate(text)).toBe(text);
});

test("leaves shadowed calls and already-passing programs unchanged", async () => {
  const shadowed = 'const process = { cwd: () => "local" }; const wrong: number = "x"; return process.cwd();';
  expect(check(shadowed, declarations).ok).toBe(false);
  expect(candidate(shadowed)).toBe(shadowed);
  const valid = 'const process = { cwd: () => "local" }; return process.cwd();';
  expect(check(valid, declarations).ok).toBe(true);
  expect(checkProgram(valid).program).toBe(valid);
  expect((await run(valid, tmpdir())).text).toBe("local");
  const mixed = 'return [process.cwd(), (() => { const process = { cwd: () => "local" }; return process.cwd(); })()];';
  expect(candidate(mixed)).toBe('return ["/fixture/project", (() => { const process = { cwd: () => "local" }; return process.cwd(); })()];');
});

test("combines cwd and accumulator repairs from the same failed check", () => {
  const code = 'const out = {}; for (const k of ["x"]) out[k] = process.cwd() + "/" + k; return out;';
  const result = checkProgram(code, { cwd: PROJECT });
  expect(result.checked.ok).toBe(true);
  expect(result.program).toContain('out: Record<string, any>');
  expect(result.program).toContain('"/fixture/project" + "/"');
});

test("does not execute when another process reference still fails after a candidate repair", async () => {
  const code = 'await Write("never", "x"); return process.cwd() + process.env.X;';
  expect(candidate(code)).toBe('await Write("never", "x"); return "/fixture/project" + process.env.X;');
  expect(checkProgram(code, { cwd: PROJECT })).toMatchObject({ program: code, checked: { ok: false } });
  const result = await run(code, tmpdir());
  expect(result.ok).toBe(false);
  expect(result.calls).toBe(0);
  expect(result.ms.run).toBe(0);
  expect(result.text).toContain("Cannot find name \'process\'");
  expect(result.text).toContain("Recovery hint: a program has no `fs`, `require` or `process`.");
  expect(result.text).toContain("Relative paths resolve against the project folder.");
});

test("an indexed accumulator can be read after it is written", async () => {
  const code = 'const out = {}; for (const k of ["x"]) out[k] = 2; return out["x"];';
  const result = await run(code, tmpdir());
  expect(result.ok).toBe(true);
  expect(result.text).toBe("2");
});

test("recognizes compound indexed assignments, not updates or shadowed assignments", () => {
  for (const op of ["=", "+=", "||=", "??="]) {
    const code = `const out = {}; out["x"] ${op} 1; return out["x"];`;
    expect(checkProgram(code).checked.ok).toBe(true);
  }
  for (const code of ['const out = {}; out["x"]++; return 1;',
    'const out = {}; { const out = {}; out["x"] = 1; } return out["x"]();']) {
    expect(checkProgram(code).checked.ok).toBe(false);
    expect(checkProgram(code).program).toBe(code);
  }
});

test("an indexed write without TS7053 still counts for a diagnosed read", () => {
  const code = 'const out = {}; out["toString"] = () => "ok"; return out["missing"];';
  expect(checkProgram(code).checked.ok).toBe(true);
});

test("annotates only declarations named by TS7053, including two accumulators", () => {
  const code = 'const first = {}, second = {}, untouched = {}; for (const key of ["x"]) { first[key] = 1; second[key] = 2; } return [first, second, untouched];';
  expect(candidate(code)).toBe('const first: Record<string, any> = {}, second: Record<string, any> = {}, untouched = {}; for (const key of ["x"]) { first[key] = 1; second[key] = 2; } return [first, second, untouched];');
  expect(check(candidate(code), declarations).ok).toBe(true);
});

test("refuses typed, non-empty and var declarations even when TS7053 points at them", () => {
  for (const declaration of ['const out: {} = {}', 'const out = { a: 1 }', 'var out = {}']) {
    const code = declaration + '; for (const key of ["x"]) out[key] = 1;';
    const checked = check(code, declarations);
    expect(checked.indexTargets?.length).toBe(1);
    expect(repairCode(code, checked.indexTargets)).toBe(code);
  }
});

test("leaves strings, template text and same-named shadow declarations alone", () => {
  const code = 'const text = "const out = {}"; const tpl = `const out = {}`; { const out = {}; for (const k of ["x"]) out[k] = 1; } const out = {}; return [text, tpl, out];';
  expect(candidate(code)).toBe('const text = "const out = {}"; const tpl = `const out = {}`; { const out: Record<string, any> = {}; for (const k of ["x"]) out[k] = 1; } const out = {}; return [text, tpl, out];');
});

test("does not annotate for other errors, and does not run a still-failing repair", async () => {
  const code = 'const out = {}; await Write("never", "x"); for (const k of ["x"]) out[k] = missing;';
  const checked = check(code, declarations);
  expect(candidate('const out = {}; return missing;')).toBe('const out = {}; return missing;');
  expect(repairCode(code, checked.indexTargets)).toContain("out: Record<string, any>");
  const result = await run(code, tmpdir());
  expect(result.ok).toBe(false);
  expect(result.calls).toBe(0);
  expect(result.text).toContain("Cannot find name \'missing\'");
});

test("a program that already passes is not rewritten", async () => {
  const code = 'const out = {}; return Object.getPrototypeOf(out) === Object.prototype;';
  expect(check(code, declarations).ok).toBe(true);
  expect(candidate(code)).toBe(code);
  expect((await run(code, tmpdir())).text).toBe("true");
});

test("returns the same string when nothing needs quoting", () => {
  const code = 'return await Read("/tmp/x");';
  expect(repairCode(code)).toBe(code);
});

test("quotes an unquoted absolute path on Read", () => {
  expect(repairCode("return await Read(/tmp/x);")).toBe('return await Read("/tmp/x");');
});

test("quotes an unquoted path on Write and Edit", () => {
  expect(repairCode('await Write(/tmp/x, "body");')).toBe('await Write("/tmp/x", "body");');
  expect(repairCode('await Edit(/tmp/x, "old", "new");')).toBe('await Edit("/tmp/x", "old", "new");');
});

test("quotes object path values", () => {
  expect(repairCode("return await Read({ file_path: /Users/foo/bar.ts });")).toBe('return await Read({ file_path: "/Users/foo/bar.ts" });');
  expect(repairCode('return await Read({ path: "/src" });')).toBe('return await Read({ path: "/src" });');
});

test("quotes the upstream path-key aliases", () => {
  expect(repairCode("return await Read({ file: /tmp/x });")).toBe('return await Read({ file: "/tmp/x" });');
  expect(repairCode("return await Edit({ filePath: /tmp/x, old_string: \"a\", new_string: \"b\" });"))
    .toBe('return await Edit({ filePath: "/tmp/x", old_string: "a", new_string: "b" });');
});

test("quotes URLs including query strings that look like paths", () => {
  expect(repairCode("return await Read(https://example.com/foo.md5?q=/a/b/c/d);"))
    .toBe('return await Read("https://example.com/foo.md5?q=/a/b/c/d");');
  expect(repairCode("return await Read(/var/folders/xx/T/cache.md5?q=/a/b/c/d/e/f/g);"))
    .toBe('return await Read("/var/folders/xx/T/cache.md5?q=/a/b/c/d/e/f/g");');
});

test("does not quote Grep's positional pattern", () => {
  const code = 'return await Grep(/TODO/, "src");';
  expect(repairCode(code)).toBe(code);
  expect(repairCode("return await Grep({ pattern: /TODO/, path: /src });")).toBe('return await Grep({ pattern: /TODO/, path: "/src" });');
});

test("does not quote Glob's positional pattern", () => {
  const code = 'return await Glob(/\\d+/);';
  expect(repairCode(code)).toBe(code);
  expect(repairCode("return await Glob({ pattern: \"*.ts\", path: /src });")).toBe('return await Glob({ pattern: "*.ts", path: "/src" });');
});

test("never touches Bash", () => {
  const code = 'return await Bash(ls /tmp/x);';
  expect(repairCode(code)).toBe(code);
  expect(repairCode('return await Bash({ command: "cat /tmp/x" });')).toBe('return await Bash({ command: "cat /tmp/x" });');
});

test("does not rewrite a path inside an already-quoted argument", () => {
  const code = 'await Write("/a.ts", "Read(/tmp/x)");';
  expect(repairCode(code)).toBe(code);
});

test("repairs a call inside a template expression", () => {
  expect(repairCode("return `x ${await Read(/tmp/x)}`;")).toBe('return `x ${await Read("/tmp/x")}`;');
});

test("normalizes unicode quotes around a path", () => {
  expect(repairCode("return await Read(\u201c/tmp/x\u201d);")).toBe('return await Read("/tmp/x");');
});

test("quotes relative, parent and home paths", () => {
  expect(repairCode("return await Read(./src/index.ts);")).toBe('return await Read("./src/index.ts");');
  expect(repairCode('await Edit(../lib/a.ts, "a", "b");')).toBe('await Edit("../lib/a.ts", "a", "b");');
  expect(repairCode("return await Read(~/.bashrc);")).toBe('return await Read("~/.bashrc");');
});

test("quotes Windows drive paths", () => {
  expect(repairCode("return await Read(C:/Users/foo/bar.ts);")).toBe('return await Read("C:/Users/foo/bar.ts");');
});

test("is idempotent", () => {
  const once = repairCode("return await Read(/tmp/x);");
  expect(repairCode(once)).toBe(once);
});

test("the host still repairs diagnosed unquoted paths", () => {
  for (const code of ["return await Read(/tmp/x);", "return await Read({ file_path: /Users/foo/bar.ts });",
    'await Write(/tmp/x, "body");', 'await Edit(../lib/a.ts, "a", "b");',
    "return await Read(https://example.com/foo.md5?q=/a/b/c/d);",
    "return await Read(/var/folders/xx/T/cache.md5?q=/a/b/c/d/e/f/g);",
    "return await Read(“/tmp/x”);", "return await Read(./src/index.ts);", "return await Read(~/.bashrc);",
    "return await Read(C:/Users/foo/bar.ts);", "return `x ${await Read(/tmp/x)}`;"]) {
    expect({ code, ok: checkProgram(code).checked.ok }).toEqual({ code, ok: true });
  }
});

test("makes a program the check rejects typecheck", () => {
  const original = "return await Read(/tmp/x);";
  expect(check(original, declarations).ok).toBe(false);
  expect(check(repairCode(original), declarations)).toEqual({ ok: true, errors: [] });
});

test("a commented-out call is left alone", () => {
  const code = "// await Read(/tmp/x)\nreturn 1;";
  expect(repairCode(code)).toBe(code);
});
