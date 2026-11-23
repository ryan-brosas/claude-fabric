import { readBool } from "../util/env";
import type { Config } from "./types";

export interface ConfigPatch {
  http?: Partial<Config["http"]>;
  db?: Partial<Config["db"]>;
  features?: Partial<Config["features"]>;
}

export function mergeConfig(base: Config, patch: ConfigPatch): Config {
  return {
    http: { ...base.http, ...patch.http },
    db: { ...base.db, ...patch.db },
    features: { ...base.features, ...patch.features },
  };
}

export function fromEnv(env: Record<string, string | undefined>): ConfigPatch {
  const patch: ConfigPatch = {};

  if (env.APP_PORT !== undefined) patch.http = { ...patch.http, port: Number(env.APP_PORT) };
  if (env.APP_HOST !== undefined) patch.http = { ...patch.http, host: env.APP_HOST };
  if (env.APP_DB_URL !== undefined) patch.db = { ...patch.db, url: env.APP_DB_URL };
  if (env.APP_DB_POOL !== undefined) patch.db = { ...patch.db, poolSize: Number(env.APP_DB_POOL) };

  const beta = readBool(env.APP_FEATURE_BETA);
  if (beta !== undefined) patch.features = { ...patch.features, beta };
  const audit = readBool(env.APP_FEATURE_AUDIT);
  if (audit !== undefined) patch.features = { ...patch.features, auditLog: audit };

  return patch;
}
