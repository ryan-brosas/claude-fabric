import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { cacheTtlMs } from "../src/cache";
import { loadConfig } from "../src/config";

describe("feature helpers", () => {
  test("beta shortens the cache ttl", () => {
    const base = loadConfig({ env: {}, filePath: null });
    const beta = loadConfig({ env: { APP_FEATURE_BETA: "true" }, filePath: null });
    expect(cacheTtlMs(base)).toBe(300_000);
    expect(cacheTtlMs(beta)).toBe(60_000);
  });

  test("the app lists enabled features in declaration order", () => {
    const config = loadConfig({ env: { APP_FEATURE_BETA: "1", APP_FEATURE_AUDIT: "1" }, filePath: null });
    expect(createApp({ config }).features).toEqual(["beta", "auditLog"]);
  });
});
