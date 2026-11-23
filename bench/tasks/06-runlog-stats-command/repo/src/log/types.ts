export type RunStatus = "ok" | "failed" | "skipped";

export interface RunEntry {
  id: string;
  task: string;
  status: RunStatus;
  durationMs: number;
  startedAt: string;
}
