export { resolveConfig } from "./resolve";
export type { Resolved } from "./resolve";
export { schema, coerce } from "./schema";
export type { KeySpec, Kind } from "./schema";
export { collectSources } from "./sources/index";
export type { LoadInput, Source } from "./sources/index";
export { applyProfileOverlay } from "./profiles/overlay";
export { mergeDeep, mergeLists } from "./resolve/merge";
