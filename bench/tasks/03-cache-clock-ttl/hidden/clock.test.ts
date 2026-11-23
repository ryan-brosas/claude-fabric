import { describe, expect, test } from "bun:test";
import { Cache } from "../../src/cache";
import { fixedClock } from "../../src/clock";

function makeCache(start = 1_000, maxEntries?: number) {
  const clock = fixedClock(start);
  return { clock, cache: new Cache({ clock, maxEntries }) };
}

describe("expiry follows the injected clock", () => {
  test("an entry expires exactly when its ttl runs out", () => {
    const { clock, cache } = makeCache();
    cache.set("a", "v", { ttl: 100 });
    clock.advance(50);
    expect(cache.get("a")).toBe("v");
    clock.advance(50);
    expect(cache.get("a")).toBeUndefined();
  });

  test("ttl 0 and negative ttl expire immediately", () => {
    const { cache } = makeCache();
    cache.set("zero", 1, { ttl: 0 });
    cache.set("negative", 1, { ttl: -10 });
    expect(cache.get("zero")).toBeUndefined();
    expect(cache.get("negative")).toBeUndefined();
  });

  test("no ttl never expires", () => {
    const { clock, cache } = makeCache();
    cache.set("forever", 7);
    clock.advance(10_000_000_000);
    expect(cache.get("forever")).toBe(7);
  });

  test("has, size and entries ignore expired entries", () => {
    const { clock, cache } = makeCache();
    cache.set("a", 1, { ttl: 10 });
    cache.set("b", 2);
    clock.advance(20);
    expect(cache.has("a")).toBe(false);
    expect(cache.size).toBe(1);
    expect(cache.entries()).toEqual(["b"]);
  });

  test("ttl() counts down on the injected clock", () => {
    const { clock, cache } = makeCache();
    cache.set("a", 1, { ttl: 100 });
    clock.advance(25);
    expect(cache.ttl("a")).toBe(75);
    expect(cache.ttl("missing")).toBeUndefined();
    clock.advance(100);
    expect(cache.ttl("a")).toBeUndefined();
  });

  test("sweep removes only expired entries", () => {
    const { clock, cache } = makeCache();
    cache.set("a", 1, { ttl: 10 });
    cache.set("b", 2, { ttl: 100 });
    cache.set("c", 3);
    clock.advance(50);
    expect(cache.sweep()).toBe(1);
    expect(cache.entries().sort()).toEqual(["b", "c"]);
  });

  test("stats separate hits, misses and expirations", () => {
    const { clock, cache } = makeCache();
    cache.set("a", 1, { ttl: 10 });
    expect(cache.get("a")).toBe(1);
    clock.advance(20);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, expirations: 1, size: 0 });
  });
});
