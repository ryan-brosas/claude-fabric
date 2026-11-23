import { readFileSync } from "node:fs";
import type { Json } from "../resolve/merge";

export interface FileSourceInput {
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
}

export function fileValues(input: FileSourceInput = {}): Json {
  const env = input.env ?? process.env;
  const path = env.CONF_FILE ?? "conf.json";
  const readFile = input.readFile ?? ((target: string) => readFileSync(target, "utf8"));
  try {
    return JSON.parse(readFile(path)) as Json;
  } catch {
    return {};
  }
}
