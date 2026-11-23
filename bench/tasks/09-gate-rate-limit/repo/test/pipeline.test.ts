import { describe, expect, test } from "bun:test";
import { Pipeline } from "../src/pipeline";
import { json } from "../src/http";
import { auth } from "../src/middleware/auth";

const request = (headers: Record<string, string> = {}) => ({
  method: "GET",
  path: "/hello",
  clientIp: "1.2.3.4",
  headers,
});

describe("Pipeline", () => {
  test("runs the handler when no middleware answers", () => {
    const app = new Pipeline(() => json(200, { ok: true }));
    expect(app.handle(request()).body).toEqual({ ok: true });
  });

  test("stops at the first response", () => {
    const app = new Pipeline(() => json(200, { ok: true }));
    app.use(() => json(403, { blocked: true }));
    expect(app.handle(request()).status).toBe(403);
  });

  test("runs middleware in order", () => {
    const seen: string[] = [];
    const app = new Pipeline(() => json(200, { ok: true }));
    app.use(() => {
      seen.push("first");
      return null;
    });
    app.use(() => {
      seen.push("second");
      return null;
    });
    app.handle(request());
    expect(seen).toEqual(["first", "second"]);
  });
});

describe("auth", () => {
  test("rejects a missing or wrong token", () => {
    const app = new Pipeline(() => json(200, { ok: true }));
    app.use(auth({ token: "t" }));
    expect(app.handle(request()).status).toBe(401);
    expect(app.handle(request({ authorization: "Bearer nope" })).status).toBe(401);
  });

  test("passes a good token", () => {
    const app = new Pipeline(() => json(200, { ok: true }));
    app.use(auth({ token: "t" }));
    expect(app.handle(request({ authorization: "Bearer t" })).status).toBe(200);
  });
});
