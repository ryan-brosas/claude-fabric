// Runtime bridges to the byte arithmetic in proofs/bounds.ts. String identity,
// UTF-8 measurement and marker spelling remain the string builder's job.
import { addressedSample, boundedText, protectedItem, protectedShare, protectedTotal, samplePosition, textBytePlan } from "./generated/bounds.js";
import { allocateSummaryCarry } from "./context.ts";

interface Machine { init(params: object): { scalars: Record<string, number>; maps: Record<string, Map<number, number>> }; step(params: object, state: { scalars: Record<string, number>; maps: Record<string, Map<number, number>> }, input: object): { scalars: Record<string, number> } }
const run = (machine: Machine, input: object): Record<string, number> => machine.step({}, machine.init({}), input).scalars;

/** A whole-byte cap is equivalent for UTF-8 output. Negative caps have no room. */
export const byteCap = (cap: number): number => Number.isNaN(cap) ? 0 : Math.max(0, Math.floor(cap));

export interface TextPlanInput { source: number; cap: number; marker: number; head: number; tail: number; produced: number; half: number; lower: number }
export function checkedTextPlan(input: TextPlanInput): Record<string, number> {
  const result = run(textBytePlan, input);
  if (result["out.valid"] !== 1) throw new Error("fabric: byte plan failed its verified check");
  return result;
}

export function textPlan(source: number, cap: number, marker = 0, head = 0, tail = 0, produced = 0): Record<string, number> {
  const facts = { source, cap, marker, head, tail, produced, half: 0, lower: 0 };
  const room = run(textBytePlan, facts)["out.room"]!;
  return checkedTextPlan({ ...facts, half: Math.floor(room / 2), lower: Math.floor(cap / 2) });
}

export interface TextFacts { source: number; cap: number; head: number; tail: number; marker: number; omitted: number; markerCount: number; output: number; unchanged: boolean; marked: boolean }
export function acceptBoundedText(facts: TextFacts): boolean {
  return run(boundedText, { ...facts, unchanged: Number(facts.unchanged), marked: Number(facts.marked) })["out.accepted"] === 1;
}

export interface SampleFacts { total: number; limit: number; earliest: number; latest: number; omitted: number; lower: number; upper: number }
export const acceptAddressedSample = (facts: SampleFacts): boolean => run(addressedSample, facts)["out.accepted"] === 1;

export interface SamplePositionFacts { total: number; first: number; last: number; position: number; actual: number }
export const checkedSamplePosition = (facts: SamplePositionFacts): boolean => run(samplePosition, facts)["out.accepted"] === 1;

// summaryCarry proves this allocation is min(bytes, cap) when the other demands are zero.
export const sectionBytes = (bytes: number, cap: number): number => allocateSummaryCarry(cap, 0, bytes, 0, 0).newestBytes;

export interface ShareFacts { cap: number; header: number; count: number; quotient: number; remainder: number }
export function checkedProtectedShare(facts: ShareFacts): Record<string, number> {
  const result = run(protectedShare, facts);
  if (result["out.valid"] !== 1) throw new Error("fabric: protected share failed its verified check");
  return result;
}
export function protectedRoom(cap: number, header: number, count: number): { room: number; share: number } {
  const initial = { cap, header, count, quotient: 0, remainder: 0 };
  const room = run(protectedShare, initial)["out.room"]!;
  const quotient = Math.floor(room / count);
  const remainder = room - quotient * count;
  checkedProtectedShare({ ...initial, quotient, remainder });
  return { room, share: quotient };
}
export interface TotalFacts { room: number; used: number; amount: number; demand: number }
export function checkedProtectedTotal(facts: TotalFacts): number {
  const result = run(protectedTotal, facts);
  if (result["out.valid"] !== 1) throw new Error("fabric: protected total failed its verified check");
  return result["out.next"]!;
}

export const protectedItemBytes = (demand: number, share: number, base: number, remaining: number): Record<string, number> =>
  run(protectedItem, { demand, share, base, remaining });
