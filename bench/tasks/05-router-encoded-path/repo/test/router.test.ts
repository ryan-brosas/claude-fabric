import { describe, expect, test } from "bun:test";
import { createHandler } from "../src/server";

const handler = createHandler();
const get = (path: string, headers: Record<string, string> = {}) =>
  handler(new Request(`http://local${path}`, { headers }));

describe("handler", () => {
  test("serves health", async () => {
    const response = await get("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("serves a plain path parameter", async () => {
    const response = await get("/users/42");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "42", name: "Ada" });
  });

  test("serves a file name", async () => {
    const response = await get("/files/readme");
    expect(await response.json()).toEqual({ name: "readme" });
  });

  test("returns 404 for unknown paths", async () => {
    const response = await get("/nope");
    expect(response.status).toBe(404);
  });

  test("guards admin routes", async () => {
    const anon = await get("/admin/stats");
    expect(anon.status).toBe(401);
    const allowed = await get("/admin/stats", { "x-admin-token": "dev-token" });
    expect(allowed.status).toBe(200);
  });

  test("rejects null bytes and bad escapes", async () => {
    expect((await get("/files/%00")).status).toBe(400);
    expect((await get("/files/%zz")).status).toBe(400);
  });
});
