import { describe, expect, test } from "bun:test";
import { matches, splitTopic, validatePattern } from "../src/topic";

describe("splitTopic", () => {
  test("splits on dots", () => {
    expect(splitTopic("user.profile.updated")).toEqual(["user", "profile", "updated"]);
  });

  test("rejects empty segments", () => {
    expect(() => splitTopic("user..created")).toThrow();
  });
});

describe("matches", () => {
  test("literal topics match themselves", () => {
    expect(matches("user.created", "user.created")).toBe(true);
    expect(matches("user.created", "user.deleted")).toBe(false);
  });

  test("a star matches exactly one segment in the middle", () => {
    expect(matches("user.*.updated", "user.profile.updated")).toBe(true);
    expect(matches("user.*.updated", "user.updated")).toBe(false);
  });

  test("a hash matches the rest of the tree", () => {
    expect(matches("job.#", "job.retry.failed")).toBe(true);
    expect(matches("job.#", "job")).toBe(true);
    expect(matches("job.#", "billing.invoice.paid")).toBe(false);
  });
});

describe("validatePattern", () => {
  test("rejects a hash that is not last", () => {
    expect(() => validatePattern("job.#.started")).toThrow();
  });
});
