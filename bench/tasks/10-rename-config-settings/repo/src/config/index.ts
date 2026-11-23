import { readFileSync } from "node:fs";
import { defaultConfig } from "./defaults";
import { fromEnv, mergeConfig } from "./load";
import type { Config } from "./types";

export interface LoadConfigOptions {
  env?: Record<string, string | undefined>;
  filePath?: string | null;
  readFile?: (path: string) => string;
}

const readText = (path: string): string => readFileSync(path, "utf8");

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const filePath = options.filePath ?? env.APP_CONFIG ?? null;
  const readFile = options.readFile ?? readText;

  let config = defaultConfig;
  if (filePath) {
    config = mergeConfig(config, JSON.parse(readFile(filePath)) as Config);
  }
  return mergeConfig(config, fromEnv(env));
}

export { defaultConfig } from "./defaults";
export { fromEnv, mergeConfig } from "./load";
export type { ConfigPatch } from "./load";
export type { Config, ConfigSource } from "./types";
