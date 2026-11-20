import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseTranscript } from "../../src/recall/transcript.ts";

const fixture = readFileSync(new URL("./fixtures/chain.jsonl", import.meta.url), "utf8");

test("follows the active chain across an out-of-order compact boundary", () => {
  const parsed = parseTranscript(fixture);
  expect(parsed.entries.map((entry) => entry.uuid)).toEqual(["u1", "a1", "r1", "s1", "u2"]);
  expect(parsed.entries.map((entry) => entry.kind)).toEqual(["user", "tool", "tool_result", "summary", "user"]);
  expect(parsed.entries[1]!.text).toContain('Tool: Read({"file_path":"secret-note.txt"})');
  expect(parsed.entries[2]!.text).toContain("ALMANAC-493");
  expect(parsed.boundaries).toEqual([{ uuid: "b1", uuids: ["u1", "a1"], allUuids: ["u1", "a1", "missing-uuid"], unresolvable: ["missing-uuid"] }]);
});
