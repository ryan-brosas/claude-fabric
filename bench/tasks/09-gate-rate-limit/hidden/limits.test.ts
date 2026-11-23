import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { GateRequest } from "../../src/http";

function makeApp(options: { limit?: number; windowMs?: number; now?: () => number } = {}) {
  const clock = { t: 1_000 };
  const app = createApp({
    auth: { token: "t" },
    rateLimit: { limit: options.limit ?? 3, windowMs: options.windowMs ?? 1_000 },
    now: options.now ?? (() => clock.t),
  });
  const request = (ip = "1.2.3.4", path = "/hello", token = "t"): GateRequest => ({
    method: "GET",
    path,
    clientIp: ip,
    headers: { authorization: `Bearer ${token}` },
  });
  return { app, clock, request };
}

describe("rate limiting", () => {
  test("allows the configured number then answers 429", () => {
    const { app, request } = makeApp();
    for (let index = 0; index < 3; index += 1) {
      expect(app.handle(request()).status).toBe(200);
    }
    const blocked = app.handle(request());
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "rate_limited", retryAfterMs: 1_000 });
    expect(blocked.headers["retry-after"]).toBe("1");
  });

  test("retryAfterMs counts down to the oldest request leaving the window", () => {
    const { app, clock, request } = makeApp();
    for (let index = 0; index < 3; index += 1) app.handle(request());
    clock.t += 400;
    const blocked = app.handle(request());
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "rate_limited", retryAfterMs: 600 });
    expect(blocked.headers["retry-after"]).toBe("1");
  });

  test("the window slides open again", () => {
    const { app, clock, request } = makeApp();
    for (let index = 0; index < 3; index += 1) app.handle(request());
    clock.t += 999;
    expect(app.handle(request()).status).toBe(429);
    clock.t += 1;
    expect(app.handle(request()).status).toBe(200);
  });

  test("different clients and paths have separate budgets", () => {
    const { app, request } = makeApp({ limit: 1 });
    expect(app.handle(request("1.1.1.1")).status).toBe(200);
    expect(app.handle(request("1.1.1.1")).status).toBe(429);
    expect(app.handle(request("2.2.2.2")).status).toBe(200);
    expect(app.handle(request("1.1.1.1", "/echo")).status).toBe(200);
  });

  test("a rejected request does not count towards the budget", () => {
    const { app, clock, request } = makeApp({ limit: 2 });
    expect(app.handle(request()).status).toBe(200);
    expect(app.handle(request()).status).toBe(200);
    expect(app.handle(request()).status).toBe(429);
    clock.t += 500;
    expect(app.handle(request()).status).toBe(429);
    clock.t += 500;
    expect(app.handle(request()).status).toBe(200);
  });

  test("unauthorized requests do not use the budget", () => {
    const { app, request } = makeApp({ limit: 2 });
    for (let index = 0; index < 5; index += 1) {
      expect(app.handle(request("1.2.3.4", "/hello", "wrong")).status).toBe(401);
    }
    expect(app.handle(request()).status).toBe(200);
    expect(app.handle(request()).status).toBe(200);
    expect(app.handle(request()).status).toBe(429);
  });

  test("a bigger window keeps the budget closed longer", () => {
    const { app, clock, request } = makeApp({ limit: 1, windowMs: 10_000 });
    expect(app.handle(request()).status).toBe(200);
    clock.t += 5_000;
    const blocked = app.handle(request());
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "rate_limited", retryAfterMs: 5_000 });
    expect(blocked.headers["retry-after"]).toBe("5");
  });
});

describe("the rest of the gate is unchanged", () => {
  test("unknown paths still answer 404 after the limiter", () => {
    const { app, request } = makeApp();
    expect(app.handle(request("1.2.3.4", "/nope")).status).toBe(404);
  });

  test("auth still runs first", () => {
    const { app, request } = makeApp();
    expect(app.handle(request("1.2.3.4", "/hello", "wrong")).status).toBe(401);
  });
});
