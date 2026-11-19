import type { Register } from "claude-code";
import { compact } from "../compaction/compact.ts";

// The in-process half of the plugin. Compaction is Fabric's deterministic
// summary: no model call, so there is nothing to precompute, and a compactor
// that throws falls back to core's own.
export const register: Register = (on) => {
  on("session.compact", ($, e, next) => {
    if (e.trigger === "precompute") return { skip: "fabric: compaction is deterministic; nothing to precompute" };
    return compact(e.messages, { instructions: e.instructions });
  }).catch(($, e, next) => next(e));
};
