import type { CacheEntry } from "./store";

export function expiresAt(now: number, ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return Number.POSITIVE_INFINITY;
  return Date.now() + ttlMs;
}

export function isExpired(entry: CacheEntry, now: number): boolean {
  return entry.expiresAt < now;
}

export function remainingTtl(entry: CacheEntry, now: number): number {
  if (!Number.isFinite(entry.expiresAt)) return Number.POSITIVE_INFINITY;
  return Math.max(0, entry.expiresAt - now);
}
