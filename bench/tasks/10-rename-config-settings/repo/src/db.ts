import { loadConfig } from "./config";

export function databasePlan(): { url: string; poolSize: number } {
  const config = loadConfig();
  return { url: config.db.url, poolSize: config.db.poolSize };
}
