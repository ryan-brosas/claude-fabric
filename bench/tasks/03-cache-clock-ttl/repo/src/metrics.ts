export interface CacheStats {
  hits: number;
  misses: number;
  expirations: number;
  size: number;
}

export class CacheMetrics {
  #hits = 0;
  #misses = 0;
  #expirations = 0;

  hit(): void {
    this.#hits += 1;
  }

  miss(): void {
    this.#misses += 1;
  }

  expire(): void {
    this.#expirations += 1;
  }

  snapshot(size: number): CacheStats {
    return { hits: this.#hits, misses: this.#misses, expirations: this.#expirations, size };
  }
}
