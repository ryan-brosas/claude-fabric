import { describe, expect, test } from "bun:test";
import { Emitter } from "../src/emitter";

describe("Emitter", () => {
  test("delivers to exact subscribers only", async () => {
    const emitter = new Emitter();
    const seen: string[] = [];
    emitter.on("user.created", () => {
      seen.push("created");
    });
    emitter.on("user.deleted", () => {
      seen.push("deleted");
    });

    const result = await emitter.emit("user.created", { id: "u_1" });

    expect(seen).toEqual(["created"]);
    expect(result).toEqual({ topic: "user.created", delivered: 1, failed: 0 });
  });

  test("once handlers run a single time", async () => {
    const emitter = new Emitter();
    let calls = 0;
    emitter.once("tick", () => {
      calls += 1;
    });

    await emitter.emit("tick");
    await emitter.emit("tick");

    expect(calls).toBe(1);
    expect(emitter.listeners("tick")).toEqual([]);
  });

  test("off stops delivery", async () => {
    const emitter = new Emitter();
    let calls = 0;
    const id = emitter.on("tick", () => {
      calls += 1;
    });

    expect(emitter.off(id)).toBe(true);
    await emitter.emit("tick");

    expect(calls).toBe(0);
  });

  test("higher priority runs first", async () => {
    const emitter = new Emitter();
    const order: string[] = [];
    emitter.on("tick", () => {
      order.push("low");
    }, { priority: 1 });
    emitter.on("tick", () => {
      order.push("high");
    }, { priority: 5 });

    await emitter.emit("tick");

    expect(order).toEqual(["high", "low"]);
  });

  test("failed handlers are counted", async () => {
    const errors: unknown[] = [];
    const emitter = new Emitter({ onError: (error) => errors.push(error) });
    emitter.on("tick", () => {
      throw new Error("boom");
    });
    emitter.on("tick", () => {});

    const result = await emitter.emit("tick");

    expect(result.failed).toBe(1);
    expect(result.delivered).toBe(1);
    expect(errors).toHaveLength(1);
  });

  test("a single segment wildcard covers every sibling", async () => {
    const emitter = new Emitter();
    const seen: string[] = [];
    emitter.on("user.*", (_payload, meta) => {
      seen.push(meta.topic);
    });

    await emitter.emit("user.created");
    await emitter.emit("user.deleted");

    expect(seen).toEqual(["user.created", "user.deleted"]);
  });
});
