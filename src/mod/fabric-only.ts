// Adapted from pi-fabric (MIT, Tom X Nguyen) src/core/tool-ownership.ts at d331f629, whose
// fabricToolLoadout hides every tool declaration but fabric_exec in full code mode. Here it is an
// opt-in for a person who wants programs only: the tools a program already runs in the server
// leave the model's list, so it cannot fall back to them one call at a time.
import { isBuiltinTool } from "../bridge/contract.ts";
import { FABRIC_EXEC_TOOL } from "../guidance/guidance.ts";
import { TOOL_NAMES } from "../providers/tools/names.ts";

/** The plugin.json userConfig field that turns the mode on; off unless set to true. */
export const FABRIC_ONLY_OPTION = "fabricOnly";

/**
 * The tools that leave the list. Read stays, because a program's Read returns text and the direct
 * tool also reads images and PDFs. WebSearch stays, because a program reaches it through the mod's
 * `$.tool.call`, and a tool hidden from the list is hidden from the mod too.
 */
export const HIDDEN_TOOLS: readonly string[] = TOOL_NAMES.filter((name) => name !== "Read" && !isBuiltinTool(name));

export const fabricOnly = (options: Readonly<Record<string, unknown>> | undefined): boolean => options?.[FABRIC_ONLY_OPTION] === true;

/** The list without the hidden tools, but only when fabric_exec is in it to take their place. */
export const withoutProgramTools = <T extends { readonly name: string }>(tools: readonly T[]): readonly T[] =>
  tools.some((tool) => tool.name === FABRIC_EXEC_TOOL) ? tools.filter((tool) => !HIDDEN_TOOLS.includes(tool.name)) : tools;
