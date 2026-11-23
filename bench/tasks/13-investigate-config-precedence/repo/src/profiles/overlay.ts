import { isPlainObject, mergeDeep, type Json } from "../resolve/merge";

/** Applied after every other source when a profile other than base is active. */
export function applyProfileOverlay(config: Json, profile: string): Json {
  if (profile === "staging") {
    return mergeDeep(config, { http: { port: 8080 }, features: { flags: ["staging"] } });
  }
  if (profile === "dev") {
    return mergeDeep(config, { http: { port: 4000, host: "127.0.0.1" }, features: { flags: ["dev"] } });
  }
  return isPlainObject(config) ? config : {};
}
