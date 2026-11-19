// Adapted from pi-fabric (MIT, Tom X Nguyen) src/core/tool-ownership.ts at d331f629, whose
// fabricToolLoadout hides every tool declaration but fabric_exec in full code mode. Here it is an
// opt-in for a person who wants programs only: the main conversation's model is not offered the
// tools a program already runs, so it cannot fall back to them one call at a time. Agents keep them.
import { isBuiltinTool } from "../bridge/contract.ts";
import { TOOL_NAMES } from "../providers/tools/names.ts";
import { toolHidden } from "./verified/tool-visibility.ts";

/** The plugin.json userConfig field that turns the mode on; off unless set to true. */
export const FABRIC_ONLY_OPTION = "fabricOnly";

const programTool = (name: string): boolean => (TOOL_NAMES as readonly string[]).includes(name);

/**
 * Offered even with the option on: Read, because a program's Read returns text and the direct tool
 * also reads images and PDFs; and a built-in a program reaches through `$.tool.call`, which skips
 * the person's permission prompts, so the model keeps its own.
 */
const kept = (name: string): boolean => name === "Read" || isBuiltinTool(name);

/** The tools the option keeps from the main conversation when fabric_exec is in the pool. */
export const HIDDEN_TOOLS: readonly string[] = TOOL_NAMES.filter((name) => toolHidden(true, true, true, true, kept(name)));

/**
 * Built-ins kept in the prompt's tool list with the option on. Read reads images and PDFs, which a
 * program cannot; Skill runs the skills the prompt lists; ToolSearch loads every deferred one.
 */
export const FOREGROUND_TOOLS: readonly string[] = ["Read", "Skill", "ToolSearch"];

/**
 * Whether the option moves a tool behind ToolSearch. pi-fabric's full code mode declares only
 * fabric_exec and a foreground list; here every other engine built-in waits behind ToolSearch, still
 * one search away, instead of sending its schema on every request (22k tokens of an interactive
 * session's 30k with code mode off). A hidden tool is left where it is: the main conversation is
 * not offered it at all (HIDDEN_TOOLS), and an agent needs it loaded.
 */
export const deferredByOption = (tool: string, provider: { plugin: string }): boolean =>
  provider.plugin === "engine" && !HIDDEN_TOOLS.includes(tool) && !FOREGROUND_TOOLS.includes(tool);

export const fabricOnly = (options: Readonly<Record<string, unknown>> | undefined): boolean => options?.[FABRIC_ONLY_OPTION] === true;

/** Whether a loop's model is offered a tool (proofs/tool-visibility.ts decides). */
export const offered = (tool: string, facts: { optionOn: boolean; agentId?: string; fabricInPool: boolean }): boolean =>
  !toolHidden(facts.optionOn, facts.agentId === undefined, facts.fabricInPool, programTool(tool), kept(tool));
