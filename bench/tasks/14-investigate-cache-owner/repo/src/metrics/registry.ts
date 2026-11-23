export interface Counters {
  requests: number;
  cacheHits: number;
  cacheMisses: number;
}

const counters: Counters = { requests: 0, cacheHits: 0, cacheMisses: 0 };

export function countRequest(): void {
  counters.requests += 1;
}

export function countCacheHit(): void {
  counters.cacheHits += 1;
}

export function countCacheMiss(): void {
  counters.cacheMisses += 1;
}

export function snapshot(): Counters {
  return { ...counters };
}
