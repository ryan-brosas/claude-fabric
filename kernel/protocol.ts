// The one list of program tools, and the messages that cross between host and worker.
export const TOOL_NAMES = ["Read", "Write", "Edit", "Grep", "Glob", "Bash"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

// Messages cross a thread, so a ref is checked at runtime too, not only by type.
export const isToolName = (ref: unknown): ref is ToolName =>
  typeof ref === "string" && (TOOL_NAMES as readonly string[]).includes(ref);

export type HostToWorker =
  | { kind: "run"; js: string; payloads: Record<string, string> }
  | { kind: "reply"; id: number; value?: unknown; error?: string };

export type WorkerToHost =
  | { kind: "call"; id: number; ref: ToolName; args: unknown[] }
  | { kind: "done"; value?: unknown; error?: string; logs: string[] };

export type Done = Extract<WorkerToHost, { kind: "done" }>;
