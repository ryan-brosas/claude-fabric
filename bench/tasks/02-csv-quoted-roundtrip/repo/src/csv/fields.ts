const WRAPPED = /^"([\s\S]*)"$/;

/**
 * Normalizes one raw cell.
 *
 * Older exporters sent quoted cells with the quotes still attached, so the
 * wrapper is stripped here before the optional trim.
 */
export function normalizeField(value: string, trim: boolean): string {
  const wrapped = WRAPPED.exec(value);
  const inner = wrapped ? wrapped[1] : value;
  return trim ? inner.trim() : inner;
}
