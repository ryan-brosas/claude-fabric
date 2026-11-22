import { createHash } from "node:crypto";
import type * as Bounds from "../../src/compaction/bounds.ts";

// Generate against a git archive of 015aee4, not a copy of the implementation in the test tree.
type Api = typeof Bounds;
type Digest = { count: number; sha256: string };
export function boundsDigests(api: Api): Record<string, Digest> {
  const groups: Record<string, { count: number; hash: ReturnType<typeof createHash> }> = {};
  const emit = (group: string, input: unknown, action: () => unknown) => {
    const current = groups[group] ??= { count: 0, hash: createHash("sha256") };
    let outcome: unknown;
    try { outcome = { value: action() }; }
    catch (error) { outcome = { error: { name: (error as Error).name, message: (error as Error).message } }; }
    current.count++;
    current.hash.update(JSON.stringify([input, outcome]) + "\n");
  };
  const texts = ["", "abc", "x".repeat(150), "A".repeat(2400), "界🦊".repeat(420),
    "a\uD800b".repeat(240), "é\n🙂界".repeat(390), "\u0000a\u200dß".repeat(350)];
  const functions = ["clipUtf8", "boundedHeadTail", "boundedExcerpt", "boundedTailExcerpt"] as const;
  for (const [index, text] of texts.entries()) for (let cap = 0; cap <= 3000; cap++) {
    for (const name of functions) emit(name, [index, cap], () => api[name](text, cap, "src"));
  }
  for (let n = 0; n <= 8; n++) for (let cap = 0; cap <= 3000; cap += 7) {
    const items = Array.from({ length: n }, (_, index) => "x界".repeat(index + 1));
    emit("protected", [n, cap], () => api.protectedBudgets("hdr", items, cap));
  }
  for (let n = 0; n <= 20; n++) for (let cap = 0; cap <= 30; cap++) {
    const items = Array.from({ length: n }, (_, index) => ({ entryId: String(index) }));
    emit("sample", [n, cap], () => api.sampleAddressed(items, cap));
  }
  const malformed = ["aa\uD800zzzzzz", "界\uD800abcd", "\uD800zzzz", "a\uDC00z".repeat(5)];
  const suffixes = ["\uDC00", "", "…", "src"];
  for (const [index, text] of malformed.entries()) for (const [suffixIndex, suffix] of suffixes.entries()) {
    for (let cap = 0; cap <= 32; cap++) emit("surrogate", [index, suffixIndex, cap], () => api.clipUtf8(text, cap, suffix));
  }
  const whole = [0, 1, 2, 1791, 1792, 1793, 32767, 32768, 32769,
    9_007_199_254_739_198, 9_007_199_254_739_199, 9_007_199_254_739_200,
    Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 1e16];
  for (const recent of whole) for (const request of whole) for (const users of whole) for (const replies of whole) {
    emit("allocation", [recent, request, users, replies], () => api.allocateProtectedRoom(recent, request, users, replies));
  }
  const sections = [[], [""], ["one", "two"], ["界🦊".repeat(2000)], ["x".repeat(40000)]];
  for (const [index, items] of sections.entries()) {
    emit("sections", [index, "recent"], () => api.recentDialogueBytes(items));
    emit("sections", [index, "request"], () => api.requestSectionBytes(items));
  }
  const digitLengths = [9, 10, 11, 99, 100, 101, 999, 1000, 1001];
  for (const length of digitLengths) for (let cap = 0; cap <= 180; cap++) {
    const text = "x".repeat(length);
    emit("markerDigits", [length, cap], () => [api.boundedHeadTail(text, cap), api.boundedExcerpt(text, cap, "src"), api.boundedTailExcerpt(text, cap, "src")]);
  }
  const huge = [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 1e16, Number.MAX_VALUE, Infinity];
  for (const [index, cap] of huge.entries()) {
    const text = "界x".repeat(20), entries = [..."abcdef"].map(entryId => ({ entryId }));
    for (const name of functions) emit("huge", [index, name], () => api[name](text, cap, "src"));
    emit("huge", [index, "protected"], () => api.protectedBudgets("hdr", ["a", "bcdef", "界"], cap));
    emit("huge", [index, "sample"], () => api.sampleAddressed(entries, cap));
    emit("huge", [index, "sampleFrom"], () => api.sampleAddressedFrom(entries, cap));
    emit("huge", [index, "marker"], () => api.earlierSummaryOmission(cap));
    emit("huge", [index, "omission"], () => api.omissionLine(cap, undefined, undefined, "items"));
  }
  return Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, { count: group.count, sha256: group.hash.digest("hex") }]));
}

if (import.meta.main) {
  const source = process.argv[2];
  if (!source) throw new Error("pass the absolute path to the baseline bounds.ts");
  const api = await import(source) as Api;
  console.log(JSON.stringify(boundsDigests(api), null, 2));
}
