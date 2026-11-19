// Copied from pi-fabric (MIT, Tom X Nguyen) proofs/index.ts at d331f629; the module list is trimmed to
// the three kernels this port ships and the generated paths point at src/compaction/verified/generated.
// The registered kernels. Each module is proved, refused in every broken
// variant, cross-checked against its builders, and compiled to
// `src/compaction/verified/generated/<module>.js`.
import { contextKernels, CONTEXT_BUGS } from "./context.ts";
import { cutKernels, CUT_BUGS } from "./cut.ts";
import type { Kernel } from "./kernel.ts";
import { policyKernels, POLICY_BUGS } from "./policy.ts";

export interface KernelModule {
  /** Generated module stem: `src/compaction/verified/generated/<stem>.js`. */
  readonly stem: string;
  /** The proof source, hashed into the report. */
  readonly source: string;
  readonly kernels: (bug?: string) => Kernel[];
  /** Deliberately broken variants: each must leave at least one claim unproven. */
  readonly bugs: readonly string[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export const modules: readonly KernelModule[] = [
  { stem: "policy", source: "proofs/policy.ts", kernels: policyKernels as any, bugs: POLICY_BUGS },
  { stem: "context", source: "proofs/context.ts", kernels: contextKernels as any, bugs: CONTEXT_BUGS },
  { stem: "cut", source: "proofs/cut.ts", kernels: cutKernels as any, bugs: CUT_BUGS },
];
