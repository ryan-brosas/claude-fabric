import { systemClock, type Clock } from "./clock";
import { CacheMetrics } from "./metrics";
import { EntryStore } from "./store";
import { expiresAt, isExpired, remainingTtl } from "./ttl";

export interface CacheOptions {
  clock?: Clock;
  maxEntries?: number;
}

export interface SetOptions {
  ttl?: number;
}

export class Cache {
  readonly #store = new EntryStore();
  readonly #metrics = new CacheMetrics();
  #clock: Clock;
  #maxEntries: number;

  constructor(options: CacheOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
  }

  set(key: string, value: unknown, options: SetOptions = {}): void {
    const now = this.#clock.now();
    const ttl = options.ttl ?? Number.POSITIVE_INFINITY;
    this.#store.set({ key, value, createdAt: now, expiresAt: expiresAt(now, ttl) });
    this.#evict();
  }

  get<T = unknown>(key: string): T | undefined {
    const entry = this.#store.get(key);
    if (!entry) {
      this.#metrics.miss();
      return undefined;
    }
    const now = this.#clock.now();
    if (isExpired(entry, now)) {
      this.#store.delete(key);
      this.#metrics.expire();
      return undefined;
    }
    this.#metrics.hit();
    return entry.value as T;
  }

  has(key: string): boolean {
    const entry = this.#store.get(key);
    if (!entry) return false;
    if (isExpired(entry, this.#clock.now())) {
      this.#store.delete(key);
      return false;
    }
    return true;
  }

  ttl(key: string): number | undefined {
    const entry = this.#store.get(key);
    if (!entry) return undefined;
    if (isExpired(entry, this.#clock.now())) return undefined;
    return remainingTtl(entry, this.#clock.now());
  }

  delete(key: string): boolean {
    return this.#store.delete(key);
  }

  clear(): void {
    this.#store.clear();
  }

  entries(): string[] {
    const now = this.#clock.now();
    return this.#store
      .entries()
      .filter((entry) => !isExpired(entry, now))
      .map((entry) => entry.key);
  }

  get size(): number {
    return this.entries().length;
  }

  sweep(): number {
    const now = this.#clock.now();
    let removed = 0;
    for (const entry of this.#store.entries()) {
      if (isExpired(entry, now)) {
        this.#store.delete(entry.key);
        removed += 1;
      }
    }
    return removed;
  }

  stats(): ReturnType<CacheMetrics["snapshot"]> {
    return this.#metrics.snapshot(this.size);
  }

  #evict(): void {
    if (!Number.isFinite(this.#maxEntries)) return;
    if (this.#store.size <= this.#maxEntries) return;
    const ordered = this.#store.entries().sort((left, right) => left.createdAt - right.createdAt);
    while (this.#store.size > this.#maxEntries && ordered.length > 0) {
      const oldest = ordered.shift();
      if (oldest) this.#store.delete(oldest.key);
    }
  }
}
