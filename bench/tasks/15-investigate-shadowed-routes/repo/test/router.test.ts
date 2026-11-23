import { describe, expect, test } from "bun:test";
import { Router } from "../src/router";

describe("Router", () => {
  test("matches literal and parameterised paths", () => {
    const router = new Router();
    router.get("/health", () => ({ status: 200, body: "ok" }));
    router.get("/items/:id", ({ params }) => ({ status: 200, body: params.id }));

    expect(router.handle("GET", "/health").status).toBe(200);
    expect(router.handle("GET", "/items/42").body).toBe("42");
  });

  test("a trailing wildcard matches below its prefix", () => {
    const router = new Router();
    router.get("/api/*", () => ({ status: 404, body: "caught" }));
    expect(router.handle("GET", "/api/anything").body).toBe("caught");
    expect(router.handle("GET", "/api").status).toBe(404);
  });

  test("the first matching route wins", () => {
    const router = new Router();
    router.get("/x", () => ({ status: 200, body: "first" }));
    router.get("/x", () => ({ status: 200, body: "second" }));
    expect(router.handle("GET", "/x").body).toBe("first");
  });
});
