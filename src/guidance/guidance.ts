// Adapted from pi-fabric (MIT, Tom X Nguyen) src/core/execution-guidelines.ts and
// src/core/system-guidance.ts at d331f629; the rules kept here are the ones Claude Code has a
// surface for, in Claude Code's own tool names, and the tool names come from this plugin's list.
import { TOOL_NAMES } from "../providers/tools/names.ts";

/** The wire name the model's pool uses for this plugin's tool. */
export const FABRIC_EXEC_TOOL = "mcp__plugin_fabric_fabric__fabric_exec";

/** The section's stable id: a plugin's own sections are "<plugin>:<name>". */
export const GUIDANCE_SECTION = "fabric:guidance";

/** What the section costs on every turn; a test refuses text past it. */
export const GUIDANCE_MAX_CHARS = 900;

const list = (names: readonly string[]): string =>
  names.length <= 1 ? names.join("") : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];

/**
 * The one system prompt section this plugin adds: when to reach for fabric_exec, and the rules a
 * program keeps. It names only what a program may call, and only in Claude Code's vocabulary.
 */
export const guidanceText = (names: readonly string[] = TOOL_NAMES): string =>
  [
    "Reach for `fabric_exec` first: one `fabric_exec` program for reads, searches, edits, even a lone command; call directly only for what a program cannot do reliably.",
    "For full file text in your context, call `Read` directly: program results are bounded.",
    "Use an async function body. Call " + list(names) + " inside it with Claude Code's field names; use `Promise.all` for independent calls.",
    "In programs, Grep large files; Read just that range. Read small files whole. Don't `cat` files through Bash.",
    "File data and command output a program only passes through never enter your context; return what you need, not raw output.",
    "Programs are type-checked first; errors show line numbers and nothing runs.",
    "`store(key, value)`/`load(key)` keep values between calls; other MCP servers: `mcp.<server>.<tool>(args)`.",
    "After compaction, use history.recall before asking or redoing work.",
  ].join(" ");

/** The section's text, built from the tool names the checker and the description already use. */
export const GUIDANCE_TEXT = guidanceText();
