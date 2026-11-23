import { loadConfig } from "./config";
import { createLogger } from "./logger";

export interface ServerPlan {
  port: number;
  host: string;
}

export function planServer(options: { port?: number } = {}): ServerPlan {
  const config = loadConfig();
  const logger = createLogger();
  const plan = { port: options.port ?? config.http.port, host: config.http.host };
  logger(`server will listen on ${plan.host}:${plan.port}`);
  return plan;
}
