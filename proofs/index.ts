// Copied from pi-fabric (MIT, Tom X Nguyen) proofs/index.ts at d331f629; the module list is trimmed
// to the kernels this port ships and each module names the generated directory it compiles to.
// The registered kernels. Each module is proved, refused in every broken
// variant, cross-checked against its builders, and compiled to
// `<out>/<module>.js`.
import { BRIDGE_BINDING_BUGS, bridgeBindingKernels } from "./bridge-binding.ts";
import { BUILTIN_ACCESS_BUGS, builtinAccessKernels } from "./builtin-access.ts";
import { CALL_TIMEOUT_BUGS, callTimeoutKernels } from "./call-timeout.ts";
import { contextKernels, CONTEXT_BUGS } from "./context.ts";
import { cutKernels, CUT_BUGS } from "./cut.ts";
import { GATE_BUGS, gateKernels } from "./gate.ts";
import { JOB_RECEIPT_BUGS, jobReceiptKernels } from "./job-receipt.ts";
import type { Kernel } from "./kernel.ts";
import { MCP_ACCESS_BUGS, mcpAccessKernels } from "./mcp-access.ts";
import { NO_CUT_BUGS, noCutKernels } from "./no-cut.ts";
import { OFFER_MEMO_BUGS, offerMemoKernels } from "./offer-memo.ts";
import { OUTCOME_CONSERVATION_BUGS, outcomeConservationKernels } from "./outcome-conservation.ts";
import { BUDGET_BUGS, outputBudgetKernels } from "./output-budget.ts";
import { policyKernels, POLICY_BUGS } from "./policy.ts";
import { RECALL_BUGS, recallKernels } from "./recall.ts";
import { REPEAT_BUGS, repeatGuardKernels } from "./repeat-guard.ts";
import { STORE_BUGS, storeLimitKernels } from "./store-limits.ts";
import { TOOL_VISIBILITY_BUGS, toolVisibilityKernels } from "./tool-visibility.ts";

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
const kernel = "src/kernel/verified/generated";
const mod = "src/mod/verified/generated";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const modules: readonly KernelModule[] = [
  { stem: "policy", source: "proofs/policy.ts", out: compaction, kernels: policyKernels as any, bugs: POLICY_BUGS },
  { stem: "context", source: "proofs/context.ts", out: compaction, kernels: contextKernels as any, bugs: CONTEXT_BUGS },
  { stem: "cut", source: "proofs/cut.ts", out: compaction, kernels: cutKernels as any, bugs: CUT_BUGS },
  { stem: "no-cut", source: "proofs/no-cut.ts", out: compaction, kernels: noCutKernels as any, bugs: NO_CUT_BUGS },
  { stem: "outcome-conservation", source: "proofs/outcome-conservation.ts", out: compaction, kernels: outcomeConservationKernels as any, bugs: OUTCOME_CONSERVATION_BUGS },
  { stem: "recall", source: "proofs/recall.ts", out: "src/recall/verified/generated", kernels: recallKernels as any, bugs: RECALL_BUGS },
  { stem: "repeat-guard", source: "proofs/repeat-guard.ts", out: stages, kernels: repeatGuardKernels as any, bugs: REPEAT_BUGS },
  { stem: "output-budget", source: "proofs/output-budget.ts", out: stages, kernels: outputBudgetKernels as any, bugs: BUDGET_BUGS },
  { stem: "store-limits", source: "proofs/store-limits.ts", out: stages, kernels: storeLimitKernels as any, bugs: STORE_BUGS },
  { stem: "gate", source: "proofs/gate.ts", out: kernel, kernels: gateKernels as any, bugs: GATE_BUGS },
  { stem: "call-timeout", source: "proofs/call-timeout.ts", out: kernel, kernels: callTimeoutKernels as any, bugs: CALL_TIMEOUT_BUGS },
  { stem: "mcp-access", source: "proofs/mcp-access.ts", out: kernel, kernels: mcpAccessKernels as any, bugs: MCP_ACCESS_BUGS },
  { stem: "builtin-access", source: "proofs/builtin-access.ts", out: kernel, kernels: builtinAccessKernels as any, bugs: BUILTIN_ACCESS_BUGS },
  { stem: "job-receipt", source: "proofs/job-receipt.ts", out: kernel, kernels: jobReceiptKernels as any, bugs: JOB_RECEIPT_BUGS },
  { stem: "bridge-binding", source: "proofs/bridge-binding.ts", out: kernel, kernels: bridgeBindingKernels as any, bugs: BRIDGE_BINDING_BUGS },
  { stem: "tool-visibility", source: "proofs/tool-visibility.ts", out: mod, kernels: toolVisibilityKernels as any, bugs: TOOL_VISIBILITY_BUGS },
  { stem: "offer-memo", source: "proofs/offer-memo.ts", out: mod, kernels: offerMemoKernels as any, bugs: OFFER_MEMO_BUGS },
];
