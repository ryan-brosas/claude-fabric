// Recover historical siblings only with transcript message, request, ancestry,
// block index and result-source evidence. A compact boundary starts a new epoch.
import type { TranscriptRow } from "../recall/transcript.ts";
import { hasOutcome, type ClaudeMessage } from "./from-claude.ts";
import { siblingGroup, siblingOrder, siblingOwner, siblingPair } from "./verified/generated/sibling-restoration.js";

type Indexed = { row: TranscriptRow; position: number; epoch: number };
type Bucket = { groups: Map<string, Indexed[]>; calls: Map<string, Indexed[]>;
  results: Map<string, Indexed[]>; sources: Map<unknown, Indexed[]> };
type Context = { byUuid: Map<unknown, Indexed>; epochs: Map<number, Bucket>; end: number; active: Set<unknown>;
  prefix: TranscriptRow[]; baseCalls: Map<string, number>; prefixCalls: Map<string, number>;
  baseOutcomes: Map<string, number>; tailOutcomes: Map<string, number> };
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
const counts = (items: readonly string[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const item of items) out.set(item, (out.get(item) ?? 0) + 1);
  return out;
};
const refusal = (): never => { throw new Error("fabric: ambiguous transcript sibling restoration"); };
const admitted = (state: { scalars: Record<string, number> }): void => {
  if (state.scalars["out.admitted"] !== 1) refusal();
};

function add<K>(map: Map<K, Indexed[]>, key: K, item: Indexed): void {
  const list = map.get(key);
  if (list) list.push(item); else map.set(key, [item]);
}

/** Index actual block occurrences, not merely rows. Only rows before the join belong here. */
export function indexSiblingRows(indexed: readonly Indexed[], end: number): Map<number, Bucket> {
  const epochs = new Map<number, Bucket>();
  for (const item of indexed) {
    if (item.position >= end) continue;
    let bucket = epochs.get(item.epoch);
    if (!bucket) { bucket = { groups: new Map(), calls: new Map(), results: new Map(), sources: new Map() }; epochs.set(item.epoch, bucket); }
    const callIds = uses(item.row), resultIds = results(item.row);
    if (callIds.length) add(bucket.groups, messageId(item.row), item);
    for (const id of callIds) add(bucket.calls, id, item);
    for (const id of resultIds) add(bucket.results, id, item);
    if (resultIds.length) add(bucket.sources, item.row.sourceToolAssistantUUID, item);
  }
  return epochs;
}

export function siblingContext(chain: TranscriptRow[], rows: Map<string, TranscriptRow>, chainEnd: number, tail: readonly ClaudeMessage[]): Context {
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
  const inlineSet = new Set(inline);
  const tailRaw = tail.flatMap((row) => row.toolResults?.map((result) => result.tool_use_id) ?? []);
  const raw = [...prefix.flatMap(results), ...tailRaw];
  return { epochs: indexSiblingRows(indexed, end), byUuid, end, active: new Set(chain.map((row) => row.uuid)), prefix,
    prefixCalls: counts(prefixCalls), baseCalls: counts([...prefixCalls, ...tailUses.map((use) => use.tool_use_id)]),
    baseOutcomes: counts([...inline, ...raw.filter((id) => !inlineSet.has(id))]),
    tailOutcomes: counts([...inline, ...tailRaw.filter((id) => !inlineSet.has(id))]) };
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

export function siblingGroupFacts(same: Indexed[], anchor: Indexed, active: Set<unknown>) {
  const connected = connectedGroup(same, active);
  return {
    anchored: Number(same.some((item) => active.has(item.row.uuid))), rows: same.length,
    metadata: count(same, (item) => typeof item.row.requestRef === "string" && Number.isSafeInteger(item.row.apiBlockIndex)),
    requests: count(same, (item) => item.row.requestRef === anchor.row.requestRef),
    indices: new Set(same.map((item) => item.row.apiBlockIndex)).size,
    connected: count(same, (item) => connected.has(item.row.uuid)),
  };
}

function groupCandidates(ctx: Context, anchor: Indexed): { same: Indexed[]; bucket: Bucket } | undefined {
  const bucket = ctx.epochs.get(anchor.epoch)!;
  const same = bucket.groups.get(messageId(anchor.row)) ?? [];
  const off = same.some((item) => !ctx.active.has(item.row.uuid));
  const hasResult = same.some((item) => (bucket.sources.get(item.row.uuid) ?? []).some((r) => !ctx.active.has(r.row.uuid)));
  if (!off && !hasResult) return undefined;
  return { same, bucket };
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

export function siblingPairFacts(ctx: Context, bucket: Bucket, item: Indexed, call: string) {
  const matched = bucket.results.get(call) ?? [];
  return { calls: (bucket.calls.get(call) ?? []).length, results: matched.length,
    sources: count(matched, (row) => row.row.sourceToolAssistantUUID === item.row.uuid && results(row.row).length === 1),
    stray: count(bucket.sources.get(item.row.uuid) ?? [], (row) => results(row.row).some((id) => !uses(item.row).includes(id))),
    baseCalls: ctx.baseCalls.get(call) ?? 0, prefixCalls: ctx.prefixCalls.get(call) ?? 0,
    existing: ctx.baseOutcomes.get(call) ?? 0, active: Number(ctx.active.has(item.row.uuid)),
    tail: ctx.tailOutcomes.get(call) ?? 0 };
}

function planCall(ctx: Context, bucket: Bucket, item: Indexed, call: string): { insert: Indexed[]; result: TranscriptRow } | undefined {
  const matched = bucket.results.get(call) ?? [];
  const facts = siblingPairFacts(ctx, bucket, item, call);
  const verdict = siblingPair.step({}, siblingPair.init({}), facts);
  // The machine leaves an already-covered call to the joined tail.
  if (verdict.scalars["out.covered"] === 1) return undefined;
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
  let next = 0;
  for (const row of prefix) {
    const position = byUuid.get(row.uuid)!.position;
    while (next < pending.length && pending[next]!.position < position) output.push(pending[next++]!.row);
    output.push(row);
  }
  output.push(...pending.slice(next).map((item) => item.row));
  return output;
}

/** Insert uniquely attributable rows, retaining the relative order of the active chain. */
export function restoreSiblings(chain: TranscriptRow[], rows: Map<string, TranscriptRow>, chainEnd: number,
  tail: readonly ClaudeMessage[]): { rows: TranscriptRow[]; pairs: Map<string, Map<string, TranscriptRow>> } {
  const ctx = siblingContext(chain, rows, chainEnd, tail);
  const additions = new Map<string, Indexed>();
  const pairs = new Map<string, Map<string, TranscriptRow>>();
  const owners = new Map<string, string>();
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
    admitted(siblingGroup.step({}, siblingGroup.init({}), siblingGroupFacts(group.same, anchor, ctx.active)));
    for (const item of group.same) for (const call of uses(item.row)) {
      const plan = planCall(ctx, group.bucket, item, call);
      if (!plan) continue;
      const signature = JSON.stringify([messageId(item.row), item.row.requestRef, item.row.apiBlockIndex,
        blocks(item.row).filter((block) => block.type === "tool_use" && block.id === call),
        blocks(plan.result).filter((block) => block.type === "tool_result" && block.tool_use_id === call),
        plan.result.toolUseResult]);
      const owner = owners.get(call);
      admitted(siblingOwner.step({}, siblingOwner.init({}), {
        seen: Number(owner !== undefined), same: Number(owner === signature),
      }));
      owners.set(call, signature);
      const uuid = item.row.uuid as string;
      const rowPairs = pairs.get(uuid) ?? new Map<string, TranscriptRow>();
      if (rowPairs.has(call)) refusal();
      rowPairs.set(call, plan.result); pairs.set(uuid, rowPairs);
      for (const candidate of plan.insert) additions.set(candidate.row.uuid as string, candidate);
    }
  }
  return { rows: merge(ctx.prefix, [...additions.values()], ctx.byUuid), pairs };
}
