import { describe, expect, test } from "bun:test";
import { defaultConfig, loadConfig } from "../src/config";

describe("loadConfig", () => {
  test("returns the defaults with an empty environment", () => {
    const config = loadConfig({ env: {}, filePath: null });
    expect(config).toEqual(defaultConfig);
  });

  test("lets the environment override single keys", () => {
    const config = loadConfig({ env: { APP_PORT: "8080", APP_FEATURE_BETA: "1" }, filePath: null });
    expect(config.http.port).toBe(8080);
    expect(config.http.host).toBe(defaultConfig.http.host);
    expect(config.features.beta).toBe(true);
  });

  test("reads a JSON file before the environment", () => {
    const readFile = () => JSON.stringify({ http: { port: 7000 }, db: { poolSize: 9 } });
    const config = loadConfig({ env: { APP_PORT: "9000" }, filePath: "app.json", readFile });
    expect(config.http.port).toBe(9000);
    expect(config.db.poolSize).toBe(9);
  });
});
