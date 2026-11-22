// Recover historical siblings only with transcript message, request, ancestry,
// block index and result-source evidence. A compact boundary starts a new epoch.
import type { TranscriptRow } from "../recall/transcript.ts";
import { hasOutcome, type ClaudeMessage } from "./from-claude.ts";
import { siblingGroup, siblingOrder, siblingPair } from "./verified/generated/sibling-restoration.js";

type Indexed = { row: TranscriptRow; position: number; epoch: number };
type Context = { indexed: Indexed[]; byUuid: Map<unknown, Indexed>; end: number; active: Set<unknown>;
  prefix: TranscriptRow[]; baseCalls: string[]; prefixCalls: string[]; baseOutcomes: string[] };
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const blocks = (row: TranscriptRow): Record<string, unknown>[] => {
  const value = object(row.message).content;
  return Array.isArray(value) ? value.map(object) : [];
};
const uses = (row: TranscriptRow): string[] => row.type === "assistant"
  ? blocks(row).filter((b) => b.type === "tool_use").map((b) => typeof b.id === "string" ? b.id : "") : [];
const results = (row: TranscriptRow): string[] => row.type === "user"
  ? blocks(row).filter((b) => b.type === "tool_result").map((b) => typeof b.tool_use_id === "string" ? b.tool_use_id : "") : [];
const messageId = (row: TranscriptRow): string => typeof object(row.message).id === "string" ? object(row.message).id as string : "";
const count = <T>(items: readonly T[], match: (item: T) => boolean): number => items.filter(match).length;
const refusal = (): never => { throw new Error("fabric: ambiguous transcript sibling restoration"); };
const admitted = (state: { scalars: Record<string, number> }): void => {
  if (state.scalars["out.admitted"] !== 1) refusal();
};

function context(chain: TranscriptRow[], rows: Map<string, TranscriptRow>, chainEnd: number, tail: readonly ClaudeMessage[]): Context {
  let epoch = 0;
  const indexed: Indexed[] = [...rows.values()].map((row, i) => {
    if (row.type === "system" && row.subtype === "compact_boundary") epoch++;
    return { row, position: i + 1, epoch };
  });
  const byUuid = new Map(indexed.map((item) => [item.row.uuid, item]));
  const end = byUuid.get(chain[chainEnd]?.uuid)?.position;
  if (!end) return refusal();
  const prefix = chain.slice(0, chainEnd).filter((row) => row.type === "user" || row.type === "assistant");
  const prefixCalls = prefix.flatMap(uses);
  const tailUses = tail.flatMap((row) => row.toolUses);
  const inline = tailUses.filter(hasOutcome).map((use) => use.tool_use_id);
  const raw = [...prefix.flatMap(results), ...tail.flatMap((row) => row.toolResults?.map((result) => result.tool_use_id) ?? [])];
  return { indexed, byUuid, end, active: new Set(chain.map((row) => row.uuid)), prefix, prefixCalls,
    baseCalls: [...prefixCalls, ...tailUses.map((use) => use.tool_use_id)],
    baseOutcomes: [...inline, ...raw.filter((id) => !inline.includes(id))] };
}

function connectedGroup(same: Indexed[], active: Set<unknown>): Set<unknown> {
  const connected = new Set(same.filter((item) => active.has(item.row.uuid)).map((item) => item.row.uuid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of same) if (!connected.has(item.row.uuid) && connected.has(item.row.parentUuid)) {
      connected.add(item.row.uuid); changed = true;
    }
  }
  return connected;
}

function checkGroup(same: Indexed[], anchor: Indexed, active: Set<unknown>): void {
  const connected = connectedGroup(same, active);
  admitted(siblingGroup.step({}, siblingGroup.init({}), {
    anchored: Number(same.some((item) => active.has(item.row.uuid))), rows: same.length,
    metadata: count(same, (item) => typeof item.row.requestRef === "string" && Number.isSafeInteger(item.row.apiBlockIndex)),
    requests: count(same, (item) => item.row.requestRef === anchor.row.requestRef),
    indices: new Set(same.map((item) => item.row.apiBlockIndex)).size,
    connected: count(same, (item) => connected.has(item.row.uuid)),
  }));
}

function groupCandidates(ctx: Context, anchor: Indexed): { same: Indexed[]; local: Indexed[] } | undefined {
  const local = ctx.indexed.filter((item) => item.epoch === anchor.epoch && item.position < ctx.end);
  const same = local.filter((item) => item.row.type === "assistant" && messageId(item.row) === messageId(anchor.row) && uses(item.row).length);
  const off = same.filter((item) => !ctx.active.has(item.row.uuid));
  const hasResult = same.some((item) => local.some((r) => !ctx.active.has(r.row.uuid)
    && r.row.sourceToolAssistantUUID === item.row.uuid && results(r.row).length));
  // #59 handles current-event-only results; no historical candidate means no decision here.
  if (!off.length && !hasResult) return undefined;
  return { same, local };
}

function checkOrder(ctx: Context, candidate: Indexed, call: Indexed, result: Indexed): void {
  const positions = ctx.prefix.map((row) => ctx.byUuid.get(row.uuid)!.position);
  const firstLater = positions.findIndex((position) => position > candidate.position);
  const insertion = firstLater < 0 ? positions.length : firstLater;
  admitted(siblingOrder.step({}, siblingOrder.init({}), {
    previous: positions[insertion - 1] ?? 0, position: candidate.position, next: positions[insertion] ?? ctx.end,
    misplaced: count(positions.slice(insertion), (position) => position < candidate.position),
    callPosition: call.position, resultPosition: result.position,
  }));
}

function planCall(ctx: Context, local: Indexed[], item: Indexed, call: string): { insert: Indexed[]; result: TranscriptRow } {
  const matched = local.filter((row) => results(row.row).includes(call));
  const verdict = siblingPair.step({}, siblingPair.init({}), {
    calls: count(local, (row) => uses(row.row).includes(call)), results: matched.length,
    sources: count(matched, (row) => row.row.sourceToolAssistantUUID === item.row.uuid && results(row.row).length === 1),
    stray: count(local, (row) => row.row.sourceToolAssistantUUID === item.row.uuid
      && results(row.row).some((id) => !uses(item.row).includes(id))),
    baseCalls: count(ctx.baseCalls, (id) => id === call), prefixCalls: count(ctx.prefixCalls, (id) => id === call),
    existing: count(ctx.baseOutcomes, (id) => id === call),
  });
  admitted(verdict);
  const result = matched[0]!;
  const candidates = [...(verdict.scalars["out.addCall"] === 1 ? [item] : []),
    ...(verdict.scalars["out.addResult"] === 1 ? [result] : [])];
  for (const candidate of candidates) checkOrder(ctx, candidate, item, result);
  return { insert: candidates, result: result.row };
}

function merge(prefix: TranscriptRow[], additions: Indexed[], byUuid: Map<unknown, Indexed>): TranscriptRow[] {
  const output: TranscriptRow[] = [];
  const pending = additions.sort((a, b) => a.position - b.position);
  for (const row of prefix) {
    const position = byUuid.get(row.uuid)!.position;
    while (pending.length && pending[0]!.position < position) output.push(pending.shift()!.row);
    output.push(row);
  }
  output.push(...pending.map((item) => item.row));
  return output;
}

/** Insert uniquely attributable rows, retaining the relative order of the active chain. */
export function restoreSiblings(chain: TranscriptRow[], rows: Map<string, TranscriptRow>, chainEnd: number,
  tail: readonly ClaudeMessage[]): { rows: TranscriptRow[]; pairs: Map<string, TranscriptRow> } {
  const ctx = context(chain, rows, chainEnd, tail);
  const additions = new Map<string, Indexed>();
  const pairs = new Map<string, TranscriptRow>();
  const handled = new Set<string>();
  for (const row of ctx.prefix) {
    const anchor = ctx.byUuid.get(row.uuid)!;
    const id = messageId(row);
    if (!id || !uses(row).length) continue;
    const key = anchor.epoch + ":" + id;
    if (handled.has(key)) continue;
    handled.add(key);
    const group = groupCandidates(ctx, anchor);
    if (!group) continue;
    checkGroup(group.same, anchor, ctx.active);
    for (const item of group.same) for (const call of uses(item.row)) {
      const plan = planCall(ctx, group.local, item, call);
      pairs.set(call, plan.result);
      for (const candidate of plan.insert) additions.set(candidate.row.uuid as string, candidate);
    }
  }
  return { rows: merge(ctx.prefix, [...additions.values()], ctx.byUuid), pairs };
}
