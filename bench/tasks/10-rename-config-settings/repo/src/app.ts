import { loadConfig } from "./config";
import type { Config } from "./config";
import { enabledFeatures } from "./features";

export interface App {
  config: Config;
  startedAt: string;
  features: string[];
}

export interface AppOptions {
  config?: Config;
  now?: () => Date;
}

export function createApp(options: AppOptions = {}): App {
  const config = options.config ?? loadConfig();
  const now = options.now ?? (() => new Date());
  return {
    config,
    startedAt: now().toISOString(),
    features: enabledFeatures(config),
  };
}
