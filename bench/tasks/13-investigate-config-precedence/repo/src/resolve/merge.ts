export type Json = Record<string, unknown>;

export function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeLists(left: unknown[], right: unknown[]): unknown[] {
  return [...left, ...right];
}

export function mergeDeep(base: Json, patch: Json): Json {
  const result: Json = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = mergeDeep(current, value);
      continue;
    }
    if (Array.isArray(current) && Array.isArray(value)) {
      result[key] = mergeLists(current, value);
      continue;
    }
    result[key] = value;
  }
  return result;
}
