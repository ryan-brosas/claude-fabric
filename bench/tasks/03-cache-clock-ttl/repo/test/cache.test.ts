import { describe, expect, test } from "bun:test";
import { Cache } from "../src/cache";
import { fixedClock } from "../src/clock";

describe("Cache", () => {
  test("stores and reads values", () => {
    const cache = new Cache();
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    expect(cache.has("a")).toBe(true);
    expect(cache.size).toBe(1);
  });

  test("deletes and clears", () => {
    const cache = new Cache();
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.delete("a")).toBe(true);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  test("expires entries on the system clock", async () => {
    const cache = new Cache();
    cache.set("short", 1, { ttl: 20 });
    await Bun.sleep(40);
    expect(cache.get("short")).toBeUndefined();
  });

  test("evicts the oldest entry above maxEntries", () => {
    const clock = fixedClock(1_000);
    const cache = new Cache({ clock, maxEntries: 2 });
    cache.set("a", 1);
    clock.advance(1);
    cache.set("b", 2);
    clock.advance(1);
    cache.set("c", 3);
    expect(cache.entries()).toEqual(["b", "c"]);
  });

  test("reports hits and misses", () => {
    const cache = new Cache();
    cache.get("missing");
    cache.set("a", 1);
    cache.get("a");
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });
});
