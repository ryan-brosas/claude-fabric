export class RetryError extends Error {
  readonly attempts: number;
  readonly cause: unknown;

  constructor(cause: unknown, attempts: number) {
    super(`retry gave up after ${attempts} attempts`, { cause });
    this.name = "RetryError";
    this.attempts = attempts;
    this.cause = cause;
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}
