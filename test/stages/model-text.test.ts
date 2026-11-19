import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

const STAGES = new URL("../../src/stages/", import.meta.url).pathname;

interface Found { file: string; value: string }

// Every string a file can put in front of the model: string literals and template text.
function stringsOf(file: string, text: string): Found[] {
  const found: Found[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push({ file, value: node.text });
    else if (ts.isTemplateExpression(node)) {
      found.push({ file, value: node.head.text });
      for (const span of node.templateSpans) found.push({ file, value: span.literal.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS));
  return found;
}

async function stageFiles(): Promise<string[]> {
  return (await readdir(STAGES)).filter((name) => name.endsWith(".ts")).sort();
}

test("no stage tells the model a Pi name", async () => {
  const files = await stageFiles();
  const offenders: Found[] = [];
  let seen = 0;
  for (const name of files) {
    const strings = stringsOf(name, await Bun.file(join(STAGES, name)).text());
    seen += strings.length;
    for (const string of strings) if (string.value.includes("pi.")) offenders.push(string);
  }
  // Guard the scan itself: the stages hold plenty of text, so an empty result means nothing.
  expect(files.length).toBe(6);
  expect(seen).toBeGreaterThan(60);
  expect(offenders).toEqual([]);
});

test("the scan finds a Pi name where one is", () => {
  const found = stringsOf("inline.ts", 'const a = "pi.read"; const b = `x ${y} pi.bash z`;');
  expect(found.map((string) => string.value)).toContain("pi.read");
  expect(found.some((string) => string.value.includes("pi.bash"))).toBe(true);
});

test("every stage keeps pi-fabric's credit in its first line", async () => {
  const credit = /^\/\/ Adapted from pi-fabric \(MIT, Tom X Nguyen\) src\/\S+ at d331f629; \S/;
  for (const name of await stageFiles()) {
    const first = (await Bun.file(join(STAGES, name)).text()).split("\n")[0] ?? "";
    expect({ name, credit: credit.test(first) }).toEqual({ name, credit: true });
  }
});
