// The rebuild must not discard any effective outcome the hook can see now. The compactor
// gives an inline tool-use outcome precedence over result rows with the same id.
import { exitCodeOf, hasOutcome, inlineOutcome, type ClaudeMessage, type ClaudeToolUse } from "./from-claude.ts";
import { outcomeConservation } from "./verified/generated/outcome-conservation.js";

type Outcome = { text: string; isError: boolean; effectiveError: boolean; count: number };
type Outcomes = { values: Map<string, Outcome>; calls: Map<string, ClaudeToolUse> };

function outcomes(messages: readonly ClaudeMessage[]): Outcomes {
  const calls = new Map<string, ClaudeToolUse>();
  const answered = new Set<string>();
  for (const message of messages) for (const use of message.toolUses ?? []) {
    const previous = calls.get(use.tool_use_id);
    if (previous && previous.tool !== use.tool) throw new Error("conflicting tool use id");
    calls.set(use.tool_use_id, use);
    if (hasOutcome(use)) {
      if (message.role !== "assistant") throw new Error("ambiguous tool outcome on a non-assistant use");
      answered.add(use.tool_use_id);
    }
  }
  const values = new Map<string, Outcome>();
  const add = (id: string, text: string, isError: boolean, tool: string, result: unknown): void => {
    if (typeof id !== "string" || !id || typeof text !== "string" || typeof isError !== "boolean") {
      throw new Error("ambiguous tool outcome fields");
    }
    const exit = tool === "Bash" ? exitCodeOf(result ?? calls.get(id)?.result) : null;
    const effectiveError = isError || (exit !== null && exit !== 0);
    const previous = values.get(id);
    if (previous && (previous.text !== text || previous.isError !== isError || previous.effectiveError !== effectiveError)) {
      throw new Error("conflicting tool outcome id");
    }
    if (previous) previous.count++;
    else values.set(id, { text, isError, effectiveError, count: 1 });
  };
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const use of message.toolUses ?? []) {
        if (hasOutcome(use)) {
          const outcome = inlineOutcome(use);
          add(use.tool_use_id, outcome.text, outcome.isError, use.tool, outcome.result);
        }
      }
    } else {
      for (const result of message.toolResults ?? []) {
        if (!answered.has(result.tool_use_id)) {
          add(result.tool_use_id, result.text, result.isError, calls.get(result.tool_use_id)?.tool ?? "", result.result);
        }
      }
    }
  }
  return { values, calls };
}

/** An absent result means the rebuilt input conserves the current effective outcomes. */
export function outcomeConservationProblem(current: readonly ClaudeMessage[], rebuilt: readonly ClaudeMessage[]): string | undefined {
  const required = outcomes(current);
  const available = outcomes(rebuilt);
  for (const [id, before] of required.values) {
    const after = available.values.get(id);
    const beforeTool = required.calls.get(id)?.tool;
    const afterTool = available.calls.get(id)?.tool;
    if ((beforeTool !== undefined && afterTool !== undefined && beforeTool !== afterTool)
      || (after && (before.text !== after.text || before.isError !== after.isError || before.effectiveError !== after.effectiveError))) {
      return "conflicting tool outcome id";
    }
    const verdict = outcomeConservation.step({}, outcomeConservation.init({}), { required: before.count, available: after?.count ?? 0 });
    if (verdict.scalars["out.accepted"] !== 1) return "missing tool outcome in rebuilt input";
    // Without the current call, the compactor cannot attach its result to an operation.
    if (after && beforeTool !== undefined && afterTool === undefined) return "ambiguous tool outcome: rebuilt input has no tool use";
  }
  return undefined;
}
