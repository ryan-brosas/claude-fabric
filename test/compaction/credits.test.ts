// Copied work stays credited: the MIT header names pi-fabric, its author and the
// commit it came from, on the first line of every file taken from it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const COPIED = [
  "src/compaction/bounds.ts",
  "src/compaction/dialogue.ts",
  "src/compaction/projections.ts",
  "src/compaction/render.ts",
  "src/compaction/verified/context.ts",
  "src/compaction/verified/nat.ts",
  "src/compaction/verified/policy.ts",
  "proofs/context.ts",
  "proofs/index.ts",
  "proofs/kernel.ts",
  "proofs/policy.ts",
  "scripts/proof-pool.ts",
  "scripts/proof-worker.ts",
  "scripts/proofs.ts",
] as const;

const CREDIT = /^\/\/ (Copied|Trimmed|Adapted) from pi-fabric \(MIT, Tom X Nguyen\) /;
const root = new URL("../../", import.meta.url);

test("every file copied from pi-fabric credits it on its first line", () => {
  const missing = COPIED.filter((path) => {
    // A script may open with a shebang; the credit follows it.
    const lines = readFileSync(new URL(path, root), "utf8").split("\n");
    const first = (lines[0]?.startsWith("#!") ? lines[1] : lines[0]) ?? "";
    return !CREDIT.test(first);
  });
  expect(missing).toEqual([]);
});
