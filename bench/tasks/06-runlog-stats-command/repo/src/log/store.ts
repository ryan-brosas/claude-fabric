import type { RunEntry } from "./types";

export function resolveLogPath(env: Record<string, string | undefined> = process.env): string {
  return env.RUNLOG_FILE ?? "./runlog.jsonl";
}

export async function readLog(path: string): Promise<RunEntry[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RunEntry);
}

export async function appendEntry(path: string, entry: RunEntry): Promise<void> {
  const entries = await readLog(path);
  entries.push(entry);
  await Bun.write(path, entries.map((item) => JSON.stringify(item)).join("\n") + "\n");
}
