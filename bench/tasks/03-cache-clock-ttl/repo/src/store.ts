export interface CacheEntry {
  readonly key: string;
  readonly value: unknown;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export class EntryStore {
  #entries = new Map<string, CacheEntry>();

  get(key: string): CacheEntry | undefined {
    return this.#entries.get(key);
  }

  set(entry: CacheEntry): void {
    this.#entries.set(entry.key, entry);
  }

  delete(key: string): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }

  entries(): CacheEntry[] {
    return [...this.#entries.values()];
  }
}
