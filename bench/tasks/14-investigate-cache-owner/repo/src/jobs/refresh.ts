import { LruCache } from "../cache/lru";

const refreshed = new LruCache<string, number>({ limit: 100 });

export function markRefreshed(jobId: string, at: number): void {
  refreshed.set(jobId, at);
}

export function lastRefresh(jobId: string): number | undefined {
  return refreshed.get(jobId);
}

export function trackedJobs(): number {
  return refreshed.size;
}
