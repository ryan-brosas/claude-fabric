export function matchSegments(
  pattern: string[],
  actual: string[],
): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index];
    const value = actual[index];
    if (expected === "*") continue;
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = value;
      continue;
    }
    if (expected !== value) return null;
  }
  return params;
}
