import type { Config } from "./config";

export function enabledFeatures(config: Config): string[] {
  return Object.entries(config.features)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}

export function isEnabled(config: Config, feature: keyof Config["features"]): boolean {
  return config.features[feature];
}
