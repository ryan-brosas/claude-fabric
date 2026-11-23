export interface LruOptions {
  limit?: number;
}

export class LruCache<K, V> {
  readonly #limit: number;
  readonly #entries = new Map<K, V>();

  constructor(options: LruOptions = {}) {
    this.#limit = options.limit ?? 500;
  }

  get limit(): number {
    return this.#limit;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.#entries.has(key)) this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.#limit) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}
