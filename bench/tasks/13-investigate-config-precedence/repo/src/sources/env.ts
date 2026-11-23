import type { Json } from "../resolve/merge";

export function envValues(env: Record<string, string | undefined> = process.env): Json {
  const values: Json = { http: {}, db: {}, features: {} };
  const http = values.http as Json;
  const db = values.db as Json;
  const features = values.features as Json;

  if (env.CONF_HTTP_HOST !== undefined) http.host = env.CONF_HTTP_HOST;
  if (env.CONF_HTTP_PORT !== undefined) http.port = Number(env.CONF_HTTP_PORT);
  if (env.CONF_DB_URL !== undefined) db.url = env.CONF_DB_URL;
  if (env.CONF_DB_POOL !== undefined) db.pool = Number(env.CONF_DB_POOL);
  if (env.CONF_FEATURE_BETA !== undefined) features.beta = env.CONF_FEATURE_BETA === "1";
  if (env.CONF_FLAGS !== undefined) features.flags = env.CONF_FLAGS.split(",").filter(Boolean);

  return values;
}
