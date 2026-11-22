import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { transcriptChain, type TranscriptRow } from "../../src/recall/transcript.ts";
import { hasOutcome, type ClaudeMessage } from "../../src/compaction/from-claude.ts";
import { rebuildTranscript } from "../../src/compaction/from-transcript.ts";
import { outcomeConservationProblem } from "../../src/compaction/outcome-conservation.ts";
import { restoreSiblings, siblingContext, siblingGroupFacts, siblingPairFacts } from "../../src/compaction/restore-siblings.ts";

type Fixture = { rows: TranscriptRow[]; current: ClaudeMessage[] };
const content = (row: TranscriptRow): Record<string, unknown>[] => {
  const message = row.message as { content?: unknown } | undefined;
  return Array.isArray(message?.content) ? message.content as Record<string, unknown>[] : [];
};
const ids = (row: TranscriptRow, type: string): string[] => content(row).filter((b) => b.type === type)
  .map((b) => String(type === "tool_use" ? b.id : b.tool_use_id));
const text = (rows: TranscriptRow[]) => rows.map((row) => JSON.stringify(row)).join("\n");

test("round3 every main-success #59 and new join fixture still rebuilds", () => {
  // Frozen from running 433df8a; all four were verified to conserve current outcomes.
  const fixtures: (Fixture & { name: string })[] = JSON.parse(readFileSync(new URL("./fixtures/round3-main-compat.json", import.meta.url), "utf8"));
  expect(fixtures.map((fixture) => fixture.name)).toEqual([
    "existing #59 two outcomes", "existing #59 three outcomes",
    "late historical result and #59", "outcomes straddling join",
  ]);
  for (const fixture of fixtures) {
    const rebuilt = rebuildTranscript(fixture.current, text(fixture.rows));
    expect(outcomeConservationProblem(fixture.current, rebuilt)).toBeUndefined();
  }
});
test("indexed restoration matches the unindexed 91ffecb outputs on every recorded fixture", () => {
  const six: Fixture[] = JSON.parse(readFileSync(new URL("./fixtures/parallel-six-fallbacks.json", import.meta.url), "utf8"));
  const n3: Fixture = {
    rows: readFileSync(new URL("./fixtures/parallel-n3-prefix.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    current: JSON.parse(readFileSync(new URL("./fixtures/parallel-n3-event.json", import.meta.url), "utf8")),
  };
  const expected = JSON.parse(readFileSync(new URL("./fixtures/round3-unindexed.json", import.meta.url), "utf8"));
  expect(expected).toHaveLength(7);
  for (const [i, fixture] of [...six, n3].entries()) {
    const { chain, rows } = transcriptChain(text(fixture.rows));
    const positions = new Map(chain.map((row, index) => [row.uuid, index]));
    const join = fixture.current.findIndex((message, index) => index > 0 && !!message.handle && positions.has(message.handle));
    const end = positions.get(fixture.current[join]!.handle!)!;
    const result = restoreSiblings(chain, rows, end, fixture.current.slice(join));
    const pairs = [...result.pairs.values()].flatMap((map) => [...map].map(([id, row]) => [id, row.uuid]));
    pairs.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect({ rows: result.rows.map((row) => row.uuid), pairs }).toEqual(expected[i]);
  }
});
test("adapter machine facts match an independent occurrence recount of every recorded fixture", () => {
  const six: Fixture[] = JSON.parse(readFileSync(new URL("./fixtures/parallel-six-fallbacks.json", import.meta.url), "utf8"));
  const n3: Fixture = {
    rows: readFileSync(new URL("./fixtures/parallel-n3-prefix.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    current: JSON.parse(readFileSync(new URL("./fixtures/parallel-n3-event.json", import.meta.url), "utf8")),
  };
  const duplicate: Fixture = JSON.parse(JSON.stringify(n3));
  const target = duplicate.rows.find((row) => row.type === "assistant" && ids(row, "tool_use").length > 0)!;
  const targetContent = (target.message as { content: Record<string, unknown>[] }).content;
  const firstCall = targetContent.find((block) => block.type === "tool_use")!;
  targetContent.push({ ...firstCall });
  let groups = 0, calls = 0;
  for (const fixture of [...six, n3, duplicate]) {
    const { chain, rows } = transcriptChain(text(fixture.rows));
    const positions = new Map(chain.map((row, i) => [row.uuid, i]));
    const join = fixture.current.findIndex((message, i) => i > 0 && !!message.handle && positions.has(message.handle));
    expect(join).toBeGreaterThan(0);
    const chainEnd = positions.get(fixture.current[join]!.handle!)!;
    const tail = fixture.current.slice(join);
    const ctx = siblingContext(chain, rows, chainEnd, tail);
    const all = [...rows.values()];
    const end = all.findIndex((row) => row.uuid === chain[chainEnd]!.uuid);
    let epoch = 0;
    const physical = all.slice(0, end).map((row) => {
      if (row.type === "system" && row.subtype === "compact_boundary") epoch++;
      return { row, epoch };
    });
    const prefix = chain.slice(0, chainEnd).filter((row) => row.type === "user" || row.type === "assistant");
    const tailUses = tail.flatMap((message) => message.toolUses);
    const inline = tailUses.filter(hasOutcome).map((use) => use.tool_use_id);
    const baseCalls = [...prefix.flatMap((row) => ids(row, "tool_use")), ...tailUses.map((use) => use.tool_use_id)];
    const prefixCalls = prefix.flatMap((row) => ids(row, "tool_use"));
    const raw = [...prefix.flatMap((row) => ids(row, "tool_result")),
      ...tail.flatMap((message) => message.toolResults?.map((result) => result.tool_use_id) ?? [])];
    const outcomes = [...inline, ...raw.filter((id) => !inline.includes(id))];
    const tailRaw = tail.flatMap((message) => message.toolResults?.map((result) => result.tool_use_id) ?? []);
    const tailOutcomes = [...inline, ...tailRaw.filter((id) => !inline.includes(id))];
    const active = new Set(chain.map((row) => row.uuid));
    for (const [e, bucket] of ctx.epochs) for (const [messageId, group] of bucket.groups) {
      const anchor = group.find((item) => active.has(item.row.uuid));
      if (!anchor) continue;
      const local = physical.filter((item) => item.epoch === e).map((item) => item.row);
      const same = local.filter((row) => row.type === "assistant" && (row.message as { id?: unknown })?.id === messageId && ids(row, "tool_use").length);
      const reachesActive = (row: TranscriptRow): boolean => {
        let cursor: TranscriptRow | undefined = row;
        const seen = new Set<unknown>();
        while (cursor && !seen.has(cursor.uuid)) {
          if (active.has(cursor.uuid)) return true;
          seen.add(cursor.uuid);
          cursor = same.find((other) => other.uuid === cursor?.parentUuid);
        }
        return false;
      };
      expect(siblingGroupFacts(group, anchor, ctx.active)).toEqual({
        anchored: Number(same.some((row) => active.has(row.uuid))), rows: same.length,
        metadata: same.filter((row) => typeof row.requestRef === "string" && Number.isSafeInteger(row.apiBlockIndex)).length,
        requests: same.filter((row) => row.requestRef === anchor.row.requestRef).length,
        indices: new Set(same.map((row) => row.apiBlockIndex)).size,
        connected: same.filter(reachesActive).length,
      });
      groups++;
      for (const item of group) for (const id of ids(item.row, "tool_use")) {
        const matches = local.flatMap((row) => ids(row, "tool_result").filter((found) => found === id).map(() => row));
        expect(siblingPairFacts(ctx, bucket, item, id)).toEqual({
          calls: local.flatMap((row) => ids(row, "tool_use")).filter((found) => found === id).length,
          results: matches.length,
          sources: matches.filter((row) => row.sourceToolAssistantUUID === item.row.uuid && ids(row, "tool_result").length === 1).length,
          stray: local.filter((row) => row.sourceToolAssistantUUID === item.row.uuid &&
            ids(row, "tool_result").some((found) => !ids(item.row, "tool_use").includes(found))).length,
          baseCalls: baseCalls.filter((found) => found === id).length,
          prefixCalls: prefixCalls.filter((found) => found === id).length,
          existing: outcomes.filter((found) => found === id).length,
          active: Number(active.has(item.row.uuid)), tail: tailOutcomes.filter((found) => found === id).length,
        });
        calls++;
      }
    }
  }
  expect(groups).toBeGreaterThan(0);
  expect(calls).toBeGreaterThan(0);
});
