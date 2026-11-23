import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/resolve";

const readFile = () => JSON.stringify({ http: { port: 9090 }, features: { flags: ["file"] } });

describe("resolveConfig", () => {
  test("falls back to the defaults", () => {
    const { config } = resolveConfig({ env: {}, argv: [], readFile: () => "{}" });
    expect((config.http as Record<string, unknown>).port).toBe(3000);
    expect((config.features as Record<string, unknown>).flags).toEqual(["core"]);
  });

  test("the file beats the defaults", () => {
    const { config } = resolveConfig({ env: {}, argv: [], readFile });
    expect((config.http as Record<string, unknown>).port).toBe(9090);
  });

  test("the environment beats the file", () => {
    const { config } = resolveConfig({ env: { CONF_HTTP_PORT: "7000" }, argv: [], readFile });
    expect((config.http as Record<string, unknown>).port).toBe(7000);
  });

  test("flags beat the environment", () => {
    const input = { env: { CONF_HTTP_PORT: "7000" }, argv: ["--port=6000"], readFile };
    const { config } = resolveConfig(input);
    expect((config.http as Record<string, unknown>).port).toBe(6000);
  });

  test("list values are concatenated across sources", () => {
    const { config } = resolveConfig({ env: { CONF_FLAGS: "env" }, argv: [], readFile });
    expect((config.features as Record<string, unknown>).flags).toEqual(["core", "file", "env"]);
  });

  test("the dev profile overlay runs last", () => {
    const { config, profile } = resolveConfig({ env: { CONF_PROFILE: "dev" }, argv: [], readFile });
    expect(profile).toBe("dev");
    expect((config.http as Record<string, unknown>).port).toBe(4000);
  });
});
