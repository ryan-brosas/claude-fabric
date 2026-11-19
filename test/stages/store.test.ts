import { expect, test } from "bun:test";
import { TOTAL_LIMIT, VALUE_LIMIT, commitAllowed, storable, write } from "../../src/stages/store.ts";

// The stage is the store's only rule: what one store() call does, and what the host commits.

test("write returns a new store and leaves the old one alone", () => {
  const before = storable({ keep: 1 });
  const after = write(before, "added", [2, 3]);
  expect(after).toEqual({ keep: 1, added: [2, 3] });
  expect(before).toEqual({ keep: 1 });
});

test("a value of undefined removes the key", () => {
  expect(write(storable({ a: 1, b: 2 }), "a", undefined)).toEqual({ b: 2 });
});

test("stored values are copies: changing the caller's object changes nothing", () => {
  const value = { nested: { n: 1 } };
  const kept = storable({ value }) as { value: { nested: { n: number } } };
  value.nested.n = 2;
  expect(kept.value.nested.n).toBe(1);
});

test("a key named __proto__ is an ordinary key, not the prototype", () => {
  const kept = write(storable({}), "__proto__", { polluted: true });
  expect(Object.getPrototypeOf(kept)).toBeNull();
  expect(Object.keys(kept)).toEqual(["__proto__"]);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test("a value over its limit names the key and the limit", () => {
  const huge = "x".repeat(VALUE_LIMIT);
  expect(() => write(storable({}), "huge", huge)).toThrow('store: the value for "huge" is ' + (VALUE_LIMIT + 2) + " JSON chars, over the limit of " + VALUE_LIMIT);
});

test("a store over its total limit names the key and the limit", () => {
  // 210002 JSON chars each: under the value limit, and five of them pass the total limit.
  const chunk = "x".repeat(210_000);
  const five = 5 * (210_000 + 2);
  let kept = storable({});
  for (let i = 0; i < 4; i++) kept = write(kept, "k" + i, chunk);
  expect(five).toBeGreaterThan(TOTAL_LIMIT);
  expect(() => write(kept, "k4", chunk))
    .toThrow('store: writing "k4" would make the store ' + five + " JSON chars, over the limit of " + TOTAL_LIMIT);
});

test("a value JSON cannot hold is refused by its key", () => {
  expect(() => storable({ fn: () => 1 })).toThrow('store: the value for "fn" is not JSON');
});

test("commits only a successful run that staged a write", () => {
  expect(commitAllowed(true, true)).toBe(true);
  expect(commitAllowed(false, true)).toBe(false);
  expect(commitAllowed(true, false)).toBe(false);
  expect(commitAllowed(false, false)).toBe(false);
});
