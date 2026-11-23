import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { defaultSettings, loadSettings } from "../../src/settings/index";

describe("the renamed settings module", () => {
  test("keeps the defaults", () => {
    const settings = loadSettings({ env: {}, filePath: null });
    expect(settings).toEqual(defaultSettings);
    expect(settings.http.port).toBe(3000);
    expect(settings.db.poolSize).toBe(5);
    expect(settings.features).toEqual({ beta: false, auditLog: false });
  });

  test("still reads the environment", () => {
    const settings = loadSettings({
      env: { APP_PORT: "8080", APP_HOST: "0.0.0.0", APP_FEATURE_BETA: "1" },
      filePath: null,
    });
    expect(settings.http).toEqual({ port: 8080, host: "0.0.0.0" });
    expect(settings.features.beta).toBe(true);
    expect(settings.features.auditLog).toBe(false);
  });

  test("still merges file then environment", () => {
    const readFile = () => JSON.stringify({ http: { port: 7000 }, db: { poolSize: 9 } });
    const fileOnly = loadSettings({ env: {}, filePath: "settings.json", readFile });
    expect(fileOnly.http.port).toBe(7000);
    expect(fileOnly.db.poolSize).toBe(9);
    expect(fileOnly.http.host).toBe("127.0.0.1");

    const both = loadSettings({ env: { APP_PORT: "9000" }, filePath: "settings.json", readFile });
    expect(both.http.port).toBe(9000);
    expect(both.db.poolSize).toBe(9);
  });

  test("the app and helpers use it", () => {
    const settings = loadSettings({ env: { APP_FEATURE_AUDIT: "1" }, filePath: null });
    const app = createApp({ settings, now: () => new Date("2026-01-01T00:00:00.000Z") });
    expect(app.settings).toBe(settings);
    expect(app.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(app.features).toEqual(["auditLog"]);
  });
});
