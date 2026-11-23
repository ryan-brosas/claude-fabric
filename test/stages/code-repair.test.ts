import { expect, test } from "bun:test";
import { check } from "../../src/kernel/check.ts";
import { run } from "../../src/kernel/host.ts";
import { tmpdir } from "node:os";
import { TOOLS } from "../../src/providers/tools/index.ts";
import { guestTypes } from "../../src/registry/generate.ts";
import { repairCode } from "../../src/stages/code-repair.ts";

const declarations = guestTypes(TOOLS);

test("repairs an empty object accumulator rejected by the check", async () => {
  const code = 'const out = {}; for (const f of ["a", "b"]) out[f] = f; return out;';
  expect(check(code, declarations).ok).toBe(false);
  const result = await run(code, tmpdir());
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.text)).toEqual({ a: "a", b: "b" });
});

const candidate = (code: string): string => repairCode(code, check(code, declarations).indexTargets);

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

test("makes a program the check rejects typecheck", () => {
  const original = "return await Read(/tmp/x);";
  expect(check(original, declarations).ok).toBe(false);
  expect(check(repairCode(original), declarations)).toEqual({ ok: true, errors: [] });
});

test("a commented-out call is left alone", () => {
  const code = "// await Read(/tmp/x)\nreturn 1;";
  expect(repairCode(code)).toBe(code);
});
