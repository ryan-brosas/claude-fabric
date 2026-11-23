import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";

describe("createApp", () => {
  test("carries the config and the enabled features", () => {
    const config = loadConfig({ env: { APP_FEATURE_AUDIT: "1" }, filePath: null });
    const app = createApp({ config, now: () => new Date("2026-01-01T00:00:00.000Z") });
    expect(app.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(app.features).toEqual(["auditLog"]);
  });

  test("defaults to an empty feature list", () => {
    const app = createApp({ config: loadConfig({ env: {}, filePath: null }) });
    expect(app.features).toEqual([]);
  });
});
