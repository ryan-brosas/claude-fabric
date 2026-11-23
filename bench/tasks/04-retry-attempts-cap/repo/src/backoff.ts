import type { RetryPolicy } from "./policy";

export function computeDelay(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = policy.baseDelayMs * policy.factor ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  const jitter = Math.floor(random() * policy.baseDelayMs * policy.jitter);
  return capped + jitter;
}

export function totalDelay(
  attempts: number,
  policy: RetryPolicy,
  random: () => number = () => 0.5,
): number {
  let total = 0;
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    total += computeDelay(attempt, policy, random);
  }
  return total;
}
