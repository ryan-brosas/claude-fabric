import { computeDelay } from "./backoff";
import { RetryError } from "./errors";
import { normalizePolicy, type RetryPolicy } from "./policy";
import { defaultSleep, type Sleep } from "./sleep";

export interface RetryOptions extends Partial<RetryPolicy> {
  sleep?: Sleep;
  random?: () => number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const policy = normalizePolicy(options);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  let lastError: unknown;

  for (let attempt = 1; attempt < policy.maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (options.shouldRetry && !options.shouldRetry(error, attempt)) throw error;
      await sleep(computeDelay(attempt, policy, random));
    }
  }

  throw new RetryError(lastError, policy.maxAttempts);
}
