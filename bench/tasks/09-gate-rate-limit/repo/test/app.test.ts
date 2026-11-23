import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";

const request = (path = "/hello", headers: Record<string, string> = { authorization: "Bearer dev-token" }) => ({
  method: "GET",
  path,
  clientIp: "1.2.3.4",
  headers,
});

describe("createApp", () => {
  test("serves /hello with auth", () => {
    const app = createApp();
    const response = app.handle(request());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ hello: "world" });
  });

  test("rejects a request without the token", () => {
    const app = createApp();
    expect(app.handle(request("/hello", {})).status).toBe(401);
  });

  test("answers 404 for unknown paths", () => {
    const app = createApp();
    expect(app.handle(request("/nope")).status).toBe(404);
  });
});
