import { describe, expect, test } from "bun:test";
import { RetryError } from "../src/errors";
import { retry } from "../src/retry";

const noopSleep = async (): Promise<void> => {};

describe("retry", () => {
  test("returns the first success without sleeping", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await retry(
      async () => {
        calls += 1;
        return "ok";
      },
      { sleep: async (ms) => {
        waits.push(ms);
      } },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  test("retries until it succeeds", async () => {
    let calls = 0;
    const result = await retry(
      async (attempt) => {
        calls += 1;
        if (attempt < 2) throw new Error("transient");
        return "ok";
      },
      { maxAttempts: 3, sleep: noopSleep },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  test("gives up with a RetryError", async () => {
    await expect(
      retry(async () => {
        throw new Error("nope");
      }, { maxAttempts: 2, sleep: noopSleep }),
    ).rejects.toBeInstanceOf(RetryError);
  });

  test("passes the attempt number to the operation", async () => {
    const seen: number[] = [];
    await retry(async (attempt) => {
      seen.push(attempt);
      return attempt;
    }, { sleep: noopSleep });
    expect(seen).toEqual([1]);
  });
});
