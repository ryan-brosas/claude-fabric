// Adapted from pi-fabric (MIT, Tom X Nguyen) src/core/tool-ownership.ts at d331f629, whose
// fabricToolLoadout hides every tool declaration but fabric_exec in full code mode. Here it is an
// opt-in for a person who wants programs only: the tools a program already runs in the server
// leave the model's list, so it cannot fall back to them one call at a time.
import { isBuiltinTool } from "../bridge/contract.ts";
import { FABRIC_EXEC_TOOL } from "../guidance/guidance.ts";
import { TOOL_NAMES } from "../providers/tools/names.ts";
import { toolHidden } from "./verified/tool-visibility.ts";

/** The plugin.json userConfig field that turns the mode on; off unless set to true. */
export const FABRIC_ONLY_OPTION = "fabricOnly";

const programTool = (name: string): boolean => (TOOL_NAMES as readonly string[]).includes(name);

/**
 * Kept even with the option on: Read, because a program's Read returns text and the direct tool
 * also reads images and PDFs; and a built-in the bridge reaches through `$.tool.call`, because a
 * tool removed from the list is removed for the mod too.
 */
const kept = (name: string): boolean => name === "Read" || isBuiltinTool(name);

/** The tools the option takes out when fabric_exec is in the pool. */
export const HIDDEN_TOOLS: readonly string[] = TOOL_NAMES.filter((name) => toolHidden(true, true, true, kept(name)));

export const fabricOnly = (options: Readonly<Record<string, unknown>> | undefined): boolean => options?.[FABRIC_ONLY_OPTION] === true;

/** The list with every tool the rule hides taken out (proofs/tool-visibility.ts decides). */
export const withoutProgramTools = <T extends { readonly name: string }>(tools: readonly T[], optionOn: boolean): readonly T[] => {
  const inPool = tools.some((tool) => tool.name === FABRIC_EXEC_TOOL);
  return tools.filter((tool) => !toolHidden(optionOn, inPool, programTool(tool.name), kept(tool.name)));
};
