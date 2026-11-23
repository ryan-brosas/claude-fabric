import { applyProfileOverlay } from "./profiles/overlay";
import { mergeDeep, type Json } from "./resolve/merge";
import { collectSources, type LoadInput } from "./sources/index";

export interface Resolved {
  config: Json;
  profile: string;
  sources: number;
}

export function resolveConfig(input: LoadInput = {}): Resolved {
  const sources = collectSources(input);
  let config: Json = {};
  for (const source of sources) {
    config = mergeDeep(config, source.values);
  }

  const env = input.env ?? process.env;
  const profile = env.CONF_PROFILE ?? "base";
  if (profile !== "base" && env.CONF_NO_PROFILE !== "1") {
    config = applyProfileOverlay(config, profile);
  }

  return { config, profile, sources: sources.length };
}
