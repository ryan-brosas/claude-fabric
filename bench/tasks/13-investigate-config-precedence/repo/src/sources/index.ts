import { cliValues } from "./cli";
import { defaults } from "./defaults";
import { envValues } from "./env";
import { fileValues } from "./file";
import type { Json } from "../resolve/merge";

export interface Source {
  name: string;
  values: Json;
}

export interface LoadInput {
  argv?: string[];
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
}

/** Every source, in the order they are merged. */
export function collectSources(input: LoadInput = {}): Source[] {
  const env = input.env ?? process.env;
  return [
    { name: "defaults", values: defaults },
    { name: "file", values: fileValues({ env, readFile: input.readFile }) },
    { name: "env", values: envValues(env) },
    { name: "cli", values: cliValues(input.argv ?? []) },
  ];
}
