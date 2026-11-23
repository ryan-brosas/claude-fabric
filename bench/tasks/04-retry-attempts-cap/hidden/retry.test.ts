import { describe, expect, test } from "bun:test";
import { RetryError } from "../../src/errors";
import { retry } from "../../src/retry";

function recorder() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => {
    waits.push(ms);
  } };
}

describe("attempt counting", () => {
  test("maxAttempts is the total number of calls", async () => {
    let calls = 0;
    const { waits, sleep } = recorder();
    await expect(
      retry(async () => {
        calls += 1;
        throw new Error(`fail ${calls}`);
      }, { maxAttempts: 4, sleep, random: () => 0 }),
    ).rejects.toBeInstanceOf(RetryError);
    expect(calls).toBe(4);
    expect(waits).toHaveLength(3);
  });

  test("maxAttempts 1 calls once and never sleeps", async () => {
    let calls = 0;
    const { waits, sleep } = recorder();
    await expect(
      retry(async () => {
        calls += 1;
        throw new Error("only");
      }, { maxAttempts: 1, sleep }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  test("a success on the second attempt stops there", async () => {
    let calls = 0;
    const { waits, sleep } = recorder();
    const value = await retry(
      async (attempt) => {
        calls += 1;
        if (attempt === 1) throw new Error("transient");
        return attempt;
      },
      { maxAttempts: 5, sleep, random: () => 0 },
    );
    expect(value).toBe(2);
    expect(calls).toBe(2);
    expect(waits).toHaveLength(1);
  });
});

describe("delay budget", () => {
  test("no wait exceeds maxDelayMs once jitter is added", async () => {
    const { waits, sleep } = recorder();
    await expect(
      retry(async () => {
        throw new Error("always");
      }, {
        maxAttempts: 6,
        baseDelayMs: 100,
        factor: 3,
        maxDelayMs: 250,
        jitter: 0.5,
        random: () => 1,
        sleep,
      }),
    ).rejects.toBeInstanceOf(RetryError);
    expect(waits).toHaveLength(5);
    for (const wait of waits) {
      expect(wait).toBeLessThanOrEqual(250);
    }
    expect(waits[0]).toBe(150);
    expect(waits[1]).toBe(250);
    expect(waits[2]).toBe(250);
  });

  test("waits grow with the configured factor when there is no jitter", async () => {
    const { waits, sleep } = recorder();
    await expect(
      retry(async () => {
        throw new Error("always");
      }, { maxAttempts: 4, baseDelayMs: 100, factor: 2, maxDelayMs: 250, jitter: 0, sleep }),
    ).rejects.toBeInstanceOf(RetryError);
    expect(waits).toEqual([100, 200, 250]);
  });
});

describe("shouldRetry", () => {
  test("stops immediately and rethrows the original error", async () => {
    let calls = 0;
    const { waits, sleep } = recorder();
    const fatal = new Error("fatal");
    let caught: unknown;
    try {
      await retry(
        async () => {
          calls += 1;
          throw fatal;
        },
        { maxAttempts: 5, sleep, shouldRetry: () => false },
      );
    } catch (error) {
      caught = error;
    }
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
    expect(caught).toBe(fatal);
    expect(caught instanceof RetryError).toBe(false);
  });

  test("can allow a few retries and then stop", async () => {
    let calls = 0;
    const { waits, sleep } = recorder();
    let caught: unknown;
    try {
      await retry(
        async () => {
          calls += 1;
          throw new Error("flaky");
        },
        { maxAttempts: 5, sleep, shouldRetry: (_error, attempt) => attempt < 2 },
      );
    } catch (error) {
      caught = error;
    }
    expect(calls).toBe(2);
    expect(waits).toHaveLength(1);
    expect(caught instanceof RetryError).toBe(false);
  });
});
