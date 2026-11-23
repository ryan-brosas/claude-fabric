import { loadConfig } from "./config";
import { createLogger } from "./logger";

export function main(argv: string[]): number {
  const config = loadConfig();
  const logger = createLogger(argv.includes("--verbose") ? "debug" : "info");
  logger(`appbox on ${config.http.host}:${config.http.port}`);
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
