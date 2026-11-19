// The fabricOnly rule: which tools the mod keeps from a loop's model, through tool.offer. That
// hides a tool from one loop only: agents keep their tools, and the mod's $.tool.call still runs
// them. Per tool it takes five facts:
//
// - the person turned fabricOnly on;
// - the loop is the main conversation, not an agent's;
// - fabric_exec is in the pool, so programs can take the tool's place;
// - the tool is a program tool, one a program runs (src/providers/tools/names.ts);
// - the tool is kept anyway: Read, which also reads images and PDFs, or a built-in the bridge
//   a program reaches through $.tool.call, which skips the person's permission prompts, so the
//   model keeps its own.
//
// A tool is hidden exactly when the first four hold and the fifth does not. The compiled machine
// is in src/mod/verified/generated/, and withoutProgramTools in src/mod/fabric-only.ts hides a tool
// only through its verdict.
import { bool, fun, no, when, yes } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type ToolVisibilityBug =
  | "hides with the option off"
  | "hides without fabric_exec"
  | "hides a kept tool"
  | "hides a tool no program runs"
  | "hides nothing"
  | "hides from an agent";

const visibility = (bug?: ToolVisibilityBug) => fun("tool visibility")
  .inputs({ optionOn: bool, mainLoop: bool, fabricInPool: bool, programTool: bool, kept: bool })
  .returns(({ optionOn, mainLoop, fabricInPool, programTool, kept }) => {
    const main = bug === "hides from an agent" ? yes : mainLoop;
    const on = bug === "hides with the option off" ? yes : optionOn;
    const pool = bug === "hides without fabric_exec" ? yes : fabricInPool;
    const program = bug === "hides a tool no program runs" ? yes : programTool;
    const spare = bug === "hides a kept tool" ? yes : kept.not();
    const hide = bug === "hides nothing" ? no : on.and(main).and(pool).and(program).and(spare);
    return { hidden: when(hide, 1, 0) };
  });

export const toolVisibilityKernels = (bug?: ToolVisibilityBug): Kernel[] => {
  const v = visibility(bug);
  return [{
    id: "toolVisibility",
    fun: v,
    decisions: [
      v.law("hidden_iff_on_main_pool_program_not_kept: a tool is hidden exactly when fabricOnly is on, the loop is the main conversation, fabric_exec is in the pool, a program runs the tool and it is not kept", () => [],
        (o, e) => o.hidden.eq(when(e.optionOn.and(e.mainLoop).and(e.fabricInPool).and(e.programTool).and(e.kept.not()), 1, 0))),
      v.law("agents_keep_their_tools: an agent's loop is never shown fewer tools", () => [],
        (o, e) => e.mainLoop.not().implies(o.hidden.eq(0))),
      v.law("off_hides_nothing: with fabricOnly off no tool is hidden", () => [],
        (o, e) => e.optionOn.not().implies(o.hidden.eq(0))),
      v.law("no_fabric_hides_nothing: without fabric_exec in the pool no tool is hidden", () => [],
        (o, e) => e.fabricInPool.not().implies(o.hidden.eq(0))),
      v.law("kept_never_hidden: Read and the bridge's built-ins are never hidden", () => [],
        (o, e) => e.kept.implies(o.hidden.eq(0))),
    ],
  }];
};

export const TOOL_VISIBILITY_BUGS: ToolVisibilityBug[] = [
  "hides with the option off",
  "hides without fabric_exec",
  "hides a kept tool",
  "hides a tool no program runs",
  "hides nothing",
  "hides from an agent",
];
