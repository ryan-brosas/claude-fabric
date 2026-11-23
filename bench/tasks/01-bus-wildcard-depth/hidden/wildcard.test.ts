import { describe, expect, test } from "bun:test";
import { Emitter } from "../../src/emitter";
import { createBus } from "../../src/bus";
import { matches } from "../../src/topic";

describe("wildcard depth", () => {
  test("a star does not reach deeper levels", () => {
    expect(matches("user.*", "user.profile.updated")).toBe(false);
    expect(matches("user.*", "user.created")).toBe(true);
    expect(matches("*", "user.created")).toBe(false);
    expect(matches("*", "user")).toBe(true);
  });

  test("a hash covers deeper levels and its own level", () => {
    expect(matches("user.#", "user.profile.updated")).toBe(true);
    expect(matches("user.#", "user.profile")).toBe(true);
    expect(matches("user.#", "user")).toBe(true);
    expect(matches("user.#", "users.created")).toBe(false);
  });
});

describe("emitter wildcard delivery", () => {
  test("a single segment subscription ignores deeper topics", async () => {
    const emitter = new Emitter();
    const seen: string[] = [];
    emitter.on("user.*", (_payload, meta) => {
      seen.push(meta.topic);
    });

    await emitter.emit("user.created");
    await emitter.emit("user.profile.updated");
    await emitter.emit("user.profile.updated.avatar");
    await emitter.emit("user");

    expect(seen).toEqual(["user.created"]);
  });

  test("a hash subscription receives the whole subtree once", async () => {
    const bus = createBus();
    const seen: string[] = [];
    bus.on("job.#", (_payload, meta) => {
      seen.push(meta.topic);
    });

    const result = await bus.emit("job.retry.failed", { attempt: 2 });

    expect(seen).toEqual(["job.retry.failed"]);
    expect(result.delivered).toBe(1);
    expect(bus.snapshot().delivered).toBe(1);
  });

  test("a star in the middle does not skip segments", async () => {
    const emitter = new Emitter();
    const seen: string[] = [];
    emitter.on("*.updated", (_payload, meta) => {
      seen.push(meta.topic);
    });

    await emitter.emit("user.updated");
    await emitter.emit("user.profile.updated");
    await emitter.emit("updated");

    expect(seen).toEqual(["user.updated"]);
  });

  test("a once wildcard fires for the first matching topic only", async () => {
    const emitter = new Emitter();
    const seen: string[] = [];
    emitter.once("user.*", (_payload, meta) => {
      seen.push(meta.topic);
    });

    await emitter.emit("user.created");
    await emitter.emit("user.created");
    await emitter.emit("user.deleted");

    expect(seen).toEqual(["user.created"]);
    expect(emitter.listeners("user.created")).toEqual([]);
  });

  test("a pattern longer than the topic never matches", async () => {
    const emitter = new Emitter();
    let calls = 0;
    emitter.on("user.*.avatar", () => {
      calls += 1;
    });

    const result = await emitter.emit("user.avatar");

    expect(calls).toBe(0);
    expect(result.delivered).toBe(0);
  });
});
