import { join } from "node:path";

export function dataDir(env: Record<string, string | undefined> = process.env): string {
  return env.DUO_DATA_DIR ?? ".data";
}

export function dataFile(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(dataDir(env), `${name}.json`);
}
