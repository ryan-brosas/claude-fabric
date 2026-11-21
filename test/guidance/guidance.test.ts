// The one system prompt section this plugin adds: its tool names come from the registry's list, it
// speaks Claude Code's vocabulary, and it stays short because every turn pays for it.
import { expect, test } from "bun:test";
import {
  FABRIC_EXEC_TOOL,
  GUIDANCE_MAX_CHARS,
  GUIDANCE_SECTION,
  GUIDANCE_TEXT,
  guidanceText,
} from "../../src/guidance/guidance.ts";
import { TOOLS } from "../../src/providers/tools/index.ts";
import { TOOL_NAMES } from "../../src/providers/tools/names.ts";

test("the names the section prints are the program tools, in the order a program sees them", () => {
  expect(TOOLS.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
});

test("the section names every program tool and no Pi vocabulary", () => {
  for (const name of TOOL_NAMES) expect(GUIDANCE_TEXT).toContain(name);
  expect(GUIDANCE_TEXT).not.toContain("pi.");
  expect(GUIDANCE_TEXT).not.toMatch(/\bpi\b/);
});

test("the section directs whole-file context reads to Read", () => {
  expect(GUIDANCE_TEXT).toContain("For full file text in your context, call `Read` directly: program results are bounded.");
});

test("the section stays under the cap that every turn pays", () => {
  expect(GUIDANCE_TEXT.length).toBeLessThan(GUIDANCE_MAX_CHARS);
});

test("the section carries the substance a program needs", () => {
  for (const phrase of [
    "one `fabric_exec` program",
    "Reach for `fabric_exec` first",
    "even a lone command",
    "only for what a program cannot do",
    "async function body",
    "with Claude Code's field names",
    "Promise.all",
    "only passes through never enter your context",
    "type-checked first",
    "Read just that range",
    "Don't `cat` files through Bash",
    "not raw output",
    "store(key, value)",
    "load(key)",
    "mcp.<server>.<tool>(args)",
  ]) {
    expect({ phrase, has: GUIDANCE_TEXT.includes(phrase) }).toEqual({ phrase, has: true });
  }
});

test("the tool list is generated, so a renamed tool changes the text", () => {
  expect(guidanceText(["Probe", "Other"])).toContain("Call Probe and Other inside it");
  expect(guidanceText(["Only"])).toContain("Call Only inside it");
});

test("the section has a stable id and names the tool by its wire name", () => {
  expect(GUIDANCE_SECTION).toBe("fabric:guidance");
  expect(FABRIC_EXEC_TOOL).toBe("mcp__plugin_fabric_fabric__fabric_exec");
});
