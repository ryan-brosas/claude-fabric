import { expect, test } from "bun:test";
import { check } from "../../src/kernel/check.ts";
import { TOOLS } from "../../src/providers/tools/index.ts";
import { guestTypes } from "../../src/registry/generate.ts";
import { repairCode } from "../../src/stages/code-repair.ts";

const declarations = guestTypes(TOOLS);

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
