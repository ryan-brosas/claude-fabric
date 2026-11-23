import { formatMs } from "../format/duration";
import { readLog, resolveLogPath } from "../log/store";
import type { CommandContext } from "./context";

export async function listCommand(context: CommandContext): Promise<number> {
  const entries = await readLog(resolveLogPath(context.env));
  for (const entry of entries) {
    context.io.out(`${entry.id} ${entry.task} ${entry.status} ${formatMs(entry.durationMs)}`);
  }
  return 0;
}
