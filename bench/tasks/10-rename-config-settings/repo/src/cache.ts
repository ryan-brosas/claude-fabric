import type { Config } from "./config";

export function cacheTtlMs(config: Config): number {
  return config.features.beta ? 60_000 : 300_000;
}
