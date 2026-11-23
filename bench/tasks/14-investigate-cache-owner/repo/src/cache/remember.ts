type Loader<T> = () => T;

const values = new Map<string, unknown>();

/**
 * Computes the value for `key` once and keeps it for the rest of the process
 * so the next call is free.
 */
export function memoize<T>(key: string, load: Loader<T>): T {
  const cached = values.get(key) as T | undefined;
  if (cached !== undefined) return cached;
  const value = load();
  values.set(key, value);
  return value;
}

export function storedKeys(): string[] {
  return [...values.keys()];
}

export function storeSize(): number {
  return values.size;
}

export function resetStore(): void {
  values.clear();
}
