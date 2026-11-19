// Copied from pi-fabric (MIT, Tom X Nguyen) proofs/index.ts at d331f629; the module list is trimmed
// to the kernels this port ships and each module names the generated directory it compiles to.
// The registered kernels. Each module is proved, refused in every broken
// variant, cross-checked against its builders, and compiled to
// `<out>/<module>.js`.
import { contextKernels, CONTEXT_BUGS } from "./context.ts";
import { cutKernels, CUT_BUGS } from "./cut.ts";
import type { Kernel } from "./kernel.ts";
import { BUDGET_BUGS, outputBudgetKernels } from "./output-budget.ts";
import { policyKernels, POLICY_BUGS } from "./policy.ts";
import { REPEAT_BUGS, repeatGuardKernels } from "./repeat-guard.ts";

export interface KernelModule {
  /** Generated module stem: `<out>/<stem>.js`. */
  readonly stem: string;
  /** The proof source, hashed into the report. */
  readonly source: string;
  /** The directory the compiled machine is written to, below the repo root. */
  readonly out: string;
  readonly kernels: (bug?: string) => Kernel[];
  /** Deliberately broken variants: each must leave at least one claim unproven. */
  readonly bugs: readonly string[];
}

const compaction = "src/compaction/verified/generated";
const stages = "src/stages/verified/generated";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const modules: readonly KernelModule[] = [
  { stem: "policy", source: "proofs/policy.ts", out: compaction, kernels: policyKernels as any, bugs: POLICY_BUGS },
  { stem: "context", source: "proofs/context.ts", out: compaction, kernels: contextKernels as any, bugs: CONTEXT_BUGS },
  { stem: "cut", source: "proofs/cut.ts", out: compaction, kernels: cutKernels as any, bugs: CUT_BUGS },
  { stem: "repeat-guard", source: "proofs/repeat-guard.ts", out: stages, kernels: repeatGuardKernels as any, bugs: REPEAT_BUGS },
  { stem: "output-budget", source: "proofs/output-budget.ts", out: stages, kernels: outputBudgetKernels as any, bugs: BUDGET_BUGS },
];
