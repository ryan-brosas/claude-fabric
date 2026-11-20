// The messages that cross between host and worker. Tool names come from the host, so the
// worker never imports the providers.

/** One run's staged writes: only these keys move when the host commits. */
export interface StoreDelta {
  /** The keys this run wrote, with the JSON copy it staged. */
  set: Record<string, unknown>;
  /** The keys this run removed. */
  remove: string[];
}

export interface RunMessage {
  kind: "run";
  js: string;
  payloads: Record<string, string>;
  names: string[];
  historyNames: string[];
  /** The session store the run starts from; the worker stages its writes itself. */
  store: Record<string, unknown>;
}

export interface ReplyMessage { kind: "reply"; id: number; value?: unknown; error?: string }

/**
 * A fresh token per run. Only the run message carries it, so the worker's closure is the one place
 * it lives; replies do not echo it, because a program can replace the worker's onmessage and read
 * what the host sends. The host checks the token on every message a program could forge.
 */
export type HostToWorker = (RunMessage & { token: string }) | ReplyMessage;

export interface CallMessage { kind: "call"; id: number; ref: string; args: unknown[] }

/**
 * The ref a program's mcp.<server>.<tool>(args) call carries. Its args are the two keys the
 * program wrote, then the tool's arguments object; the host resolves them against the session's
 * catalog.
 */
export const MCP_REF = "mcp";

export interface DoneMessage {
  kind: "done";
  /** An explicit discriminator: a thrown empty message is still a failure. */
  ok: boolean;
  value?: unknown;
  error?: string;
  logs: string[];
  /** What the program staged, sent even when it failed: the host decides whether to commit it. */
  writes: StoreDelta;
}

export type WorkerToHost = (CallMessage | DoneMessage) & { token: string };

export type Done = DoneMessage & { token: string };
