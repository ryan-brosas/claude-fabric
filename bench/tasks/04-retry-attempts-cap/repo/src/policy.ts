export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  factor: number;
  maxDelayMs: number;
  jitter: number;
}

export const defaultPolicy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 50,
  factor: 2,
  maxDelayMs: 1_000,
  jitter: 0.1,
};

export function normalizePolicy(policy: Partial<RetryPolicy> = {}): RetryPolicy {
  const merged = { ...defaultPolicy, ...policy };
  if (merged.maxAttempts < 1) throw new Error("maxAttempts must be at least 1");
  if (merged.baseDelayMs < 0) throw new Error("baseDelayMs must not be negative");
  if (merged.factor < 1) throw new Error("factor must be at least 1");
  if (merged.maxDelayMs < 0) throw new Error("maxDelayMs must not be negative");
  if (merged.jitter < 0 || merged.jitter > 1) throw new Error("jitter must be between 0 and 1");
  return merged;
}
