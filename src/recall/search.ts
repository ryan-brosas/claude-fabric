// Adapted from pi-fabric (MIT, Tom X Nguyen) packages/pi-recall/src/memory/{tokenize,index,search,context}.ts at d331f629;
// this index is rebuilt from the current transcript on each call.
import type { Entry } from "./transcript.ts";

export const tokenize = (text: string): string[] =>
  [...text.normalize("NFKC").matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => match[0].toLowerCase());
const weights: Record<Entry["kind"], number> = { assistant: 2.5, user: 2.25, summary: 1.5, tool_result: 0.75, tool: 0.7 };

// Map a normalized match back to its source character for a genuine source snippet.
const sourceOffset = (text: string, normalizedOffset: number): number => {
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (text.slice(0, middle).normalize("NFKC").toLowerCase().length <= normalizedOffset) low = middle + 1;
    else high = middle;
  }
  const start = Math.max(0, low - 1);
  return start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!) ? start - 1 : start;
};

/** BM25 (k=1.2, b=0.75) with the provenance weights from pi-recall. */
export function search(entries: readonly Entry[], query: string): { entry: Entry; score: number; snippet: string; truncated: boolean }[] {
  const trimmed = query.trim();
  const phrase = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).normalize("NFKC").toLowerCase() : undefined;
  if (phrase === "") throw new Error("history.recall: quoted phrase must not be empty");
  const terms = [...new Set(tokenize(phrase ?? query))];
  if (!terms.length && phrase === undefined) return [];
  const docs = entries.map((entry) => {
    const normalized = phrase === undefined ? undefined : entry.text.normalize("NFKC").toLowerCase();
    const match = normalized === undefined || phrase === undefined ? -1 : normalized.indexOf(phrase);
    let offset = 0, focus: number | undefined;
    let text = entry.text.slice(0, 2000);
    if (phrase !== undefined && match >= 0) {
      const position = sourceOffset(entry.text, match);
      if (!text.normalize("NFKC").toLowerCase().includes(phrase)) {
        offset = Math.max(0, position - 160);
        if (offset > 0 && /[\uDC00-\uDFFF]/.test(entry.text[offset]!)) offset--;
        text = entry.text.slice(offset, offset + 2000);
      }
      focus = position - offset;
    }
    const counts = new Map<string, number>();
    const tokens = tokenize(text);
    for (const term of tokens) counts.set(term, (counts.get(term) ?? 0) + 1);
    return { entry, text, offset, focus, match, counts, length: Math.max(1, tokens.length) };
  });
  if (!docs.length) return [];
  const avg = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length;
  const df = new Map(terms.map((term) => [term, docs.filter((doc) => doc.counts.has(term)).length]));
  return docs.flatMap((doc, index) => {
    if (phrase !== undefined && doc.match < 0) return [];
    let score = terms.length ? 0 : 1;
    for (const term of terms) {
      const tf = doc.counts.get(term) ?? 0;
      if (!tf) continue;
      const idf = Math.log((docs.length - df.get(term)! + 0.5) / (df.get(term)! + 0.5) + 1);
      score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * doc.length / avg));
    }
    // A phrase can match inside larger tokens, whose BM25 score is legitimately zero.
    if (!score && phrase === undefined) return [];
    const lower = doc.text.normalize("NFKC").toLowerCase();
    const anchor = doc.focus ?? Math.max(0, ...terms.map((term) => lower.indexOf(term)));
    const start = Math.max(0, Math.min(anchor - 160, doc.text.length - 480));
    const snippet = (doc.offset + start ? "…" : "") + doc.text.slice(start, start + 480) + (doc.offset + start + 480 < doc.entry.text.length ? "…" : "");
    return [{ entry: doc.entry, score: score * weights[doc.entry.kind], snippet, truncated: doc.text.length < doc.entry.text.length || doc.text.length > 480, index }];
  }).sort((a, b) => b.score - a.score || (terms.length ? a.index - b.index : b.index - a.index));
}
