// The messages that cross between host and worker. Tool names come from the host, so the
// worker never imports the providers.
export type HostToWorker =
  | { kind: "run"; js: string; payloads: Record<string, string>; names: string[] }
  | { kind: "reply"; id: number; value?: unknown; error?: string };

export type WorkerToHost =
  | { kind: "call"; id: number; ref: string; args: unknown[] }
  | { kind: "done"; value?: unknown; error?: string; logs: string[] };

export type Done = Extract<WorkerToHost, { kind: "done" }>;
