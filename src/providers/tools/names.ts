// The program tools' names, in the order a program sees them. TOOLS in ./index.ts is the one
// list; these are its names alone, because the mod's hooks worker refuses the zod import every
// provider pulls in, and the prompt guidance is built inside the mod.
// test/guidance/guidance.test.ts fails if this list and TOOLS drift.
export const TOOL_NAMES = ["Read", "Write", "Edit", "Grep", "Glob", "Bash", "WebSearch"] as const;
