import { describe, expect, test } from "bun:test";
import { LruCache, memoize, resetStore, storeSize } from "../src/cache/index";

describe("LruCache", () => {
  test("keeps at most limit entries", () => {
    const cache = new LruCache<string, number>({ limit: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });

  test("defaults to 500 entries", () => {
    expect(new LruCache().limit).toBe(500);
  });
});

describe("memoize", () => {
  test("computes once per key", () => {
    resetStore();
    let calls = 0;
    const load = () => {
      calls += 1;
      return { value: calls };
    };
    const first = memoize("k", load);
    const second = memoize("k", load);
    expect(second).toBe(first);
    expect(calls).toBe(1);
    expect(storeSize()).toBe(1);
  });
});
