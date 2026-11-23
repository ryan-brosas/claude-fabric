import { appendEntry, resolveLogPath } from "../log/store";
import type { RunEntry, RunStatus } from "../log/types";
import type { CommandContext } from "./context";

const STATUSES: RunStatus[] = ["ok", "failed", "skipped"];

export async function addCommand(context: CommandContext): Promise<number> {
  const [task, statusArg = "ok", durationArg = "0"] = context.args;
  if (!task) {
    context.io.err("usage: runlog add <task> [ok|failed|skipped] [durationMs]");
    return 2;
  }
  if (!STATUSES.includes(statusArg as RunStatus)) {
    context.io.err(`unknown status "${statusArg}"`);
    return 2;
  }
  const durationMs = Number(durationArg);
  if (!Number.isInteger(durationMs) || durationMs < 0) {
    context.io.err(`duration must be whole milliseconds, got "${durationArg}"`);
    return 2;
  }

  const entry: RunEntry = {
    id: `run_${Date.now().toString(36)}`,
    task,
    status: statusArg as RunStatus,
    durationMs,
    startedAt: new Date().toISOString(),
  };
  await appendEntry(resolveLogPath(context.env), entry);
  context.io.out(`added ${entry.id}`);
  return 0;
}
