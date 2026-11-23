import { describe, expect, test } from "bun:test";
import { normalizePath } from "../../src/path";
import { createHandler } from "../../src/server";

const handler = createHandler();
const get = (path: string, headers: Record<string, string> = {}) =>
  handler(new Request(`http://local${path}`, { headers }));

describe("encoded path segments", () => {
  test("an encoded slash stays inside one parameter", async () => {
    const response = await get("/files/a%2Fb");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "a/b" });
  });

  test("an encoded slash does not create extra segments", async () => {
    const response = await get("/files/a%2Fb%2Fc");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "a/b/c" });
  });

  test("a real multi-segment path still does not match one parameter", async () => {
    const response = await get("/files/a/b");
    expect(response.status).toBe(404);
  });

  test("encoded characters in a parameter are decoded", async () => {
    const response = await get("/users/%34%32");
    expect(await response.json()).toEqual({ id: "42", name: "Ada" });
  });

  test("an encoded space is kept inside the name", async () => {
    const response = await get("/files/%20pad%20");
    expect(await response.json()).toEqual({ name: " pad " });
  });
});

describe("bad paths", () => {
  test("the normalizer rejects an encoded dot dot", () => {
    expect(() => normalizePath("/files/%2e%2e")).toThrow();
    expect(() => normalizePath("/files/%2e%2e/secret")).toThrow();
  });

  test("a null byte is rejected", async () => {
    const response = await get("/files/%00");
    expect(response.status).toBe(400);
  });

  test("a broken escape is rejected", async () => {
    expect((await get("/files/%zz")).status).toBe(400);
  });
});

describe("the rest of the app still works", () => {
  test("health answers with the query ignored", async () => {
    const response = await get("/health?probe=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("the admin guard still runs", async () => {
    expect((await get("/admin/stats")).status).toBe(401);
    const allowed = await get("/admin/stats", { "x-admin-token": "dev-token" });
    expect(allowed.status).toBe(200);
  });

  test("unknown routes are 404", async () => {
    expect((await get("/nope/deeper")).status).toBe(404);
  });
});
