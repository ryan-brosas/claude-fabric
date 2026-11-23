import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";

describe("createApp", () => {
  test("serves health and the catalog", () => {
    const app = createApp();
    expect(app.handle("GET", "/health").body).toEqual({ ok: true });
    expect(app.handle("GET", "/api/products").status).toBe(200);
    expect(app.handle("GET", "/api/products/p_1").body).toEqual({ id: "p_1", name: "Blue kettle" });
  });

  test("unknown paths are 404", () => {
    const app = createApp();
    expect(app.handle("GET", "/nope").status).toBe(404);
    expect(app.handle("GET", "/api/nope").body).toEqual({ error: "api_not_found" });
  });

  test("the route table has one entry per registered handler", () => {
    expect(createApp().size).toBe(9);
  });
});
