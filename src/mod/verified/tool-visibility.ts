// The fabricOnly rule. The rule and its laws live in proofs/tool-visibility.ts; this folds one
// tool's four facts into the compiled machine.
import { toolVisibility } from "./generated/tool-visibility.js";

const bit = (fact: boolean): number => (fact ? 1 : 0);

/** Whether the mod takes a tool out of the session's list. */
export const toolHidden = (optionOn: boolean, fabricInPool: boolean, programTool: boolean, kept: boolean): boolean => {
  const state = toolVisibility.step({}, toolVisibility.init({}), {
    optionOn: bit(optionOn),
    fabricInPool: bit(fabricInPool),
    programTool: bit(programTool),
    kept: bit(kept),
  });
  return (state.scalars["out.hidden"] ?? 0) === 1;
};
