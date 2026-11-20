import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import {
  BRIDGE_HEADER,
  JOB_WAIT_MS,
  bridgePathProblem,
  bridgePaths,
  secretFileText,
  isBridgeCatalog,
  isBridgeSession,
  type BridgeCatalog,
  type BridgeJob,
  type BridgePaths,
  type BuiltinJob,
  type McpJob,
} from "../../bridge/contract.ts";
import { JobLedger } from "../verified/job-receipt.ts";

// The server's half of the socket: it holds the session's MCP catalog and turns a program's call
// into one job the mod takes and answers. Two calls cross it: an mcp call, which the mod runs with
// Claude Code's own MCP connection, and a built-in tool call, which the mod runs with
// `$.tool.call`. The mod is Claude Code's own client, so this server keeps no MCP client of its
// own, and the one queue and one answer path serve both.

/** How long one mcp call waits for the mod's answer before it rejects. Fixed; tests pass their own. */
export const ANSWER_TIMEOUT_MS = 60_000;

/**
 * How long the mod may be away before a call gives up at once. A mod that never polled, or one
 * that last polled longer ago than this, is not there to answer, and waiting the full limit would
 * only make a program slower to fail.
 */
export const MOD_GRACE_MS = 5_000;

/**
 * How long a job handed to the mod's poll may wait for the mod's receipt. The mod confirms a job
 * before it runs it, so a job whose poll response was lost on the way fails here, never run,
 * instead of at the answer limit. Fixed; tests pass their own.
 */
export const RECEIPT_TIMEOUT_MS = 5_000;

export interface BridgeOptions {
  pluginData: string;
  sessionId: string;
  /** How long one call waits for the mod's answer; ANSWER_TIMEOUT_MS when absent. */
  answerTimeoutMs?: number;
  /** How long one long poll waits for a job; JOB_WAIT_MS when absent. */
  pollMs?: number;
  /** How long a handed job waits for the mod's receipt; RECEIPT_TIMEOUT_MS when absent. */
  receiptTimeoutMs?: number;
}

/** What the server process holds while it runs: one per session, closed with the process. */
export interface Bridge {
  readonly paths: BridgePaths;
  /** The session's catalog, as the mod last sent it; empty until it sends one. */
  catalog(): BridgeCatalog;
  /** The path published for this session, absent until the mod knows it. */
  transcriptPath(): string | undefined;
  /** Asks the mod to run one tool call and resolves its raw MCP result. */
  call(server: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** Asks the mod to run one built-in tool and resolves what `$.tool.call` gave it. */
  tool(name: string, input: Record<string, unknown>): Promise<unknown>;
  /** Stops listening, fails every waiting call, and removes its socket and secret. */
  close(): void;
}

export type BridgeStart = { bridge: Bridge } | { error: string };

const emptyCatalog: BridgeCatalog = { servers: [] };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The message a start gets when another live process holds this session's lock. */
const heldMessage = (socketPath: string): string =>
  "another Fabric server is already listening on " + socketPath + " for this session; stop it, or run this one under a different session id";

/** Whether a pid is a process that still exists: kill(pid, 0) succeeds, or is refused for another user's process. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes this session's lock, or says why not. The pid is written to a private file first and
 * linked into place, so the lock never exists without its whole pid, and the link fails if a lock
 * is there. Only the holder unlinks a stale socket, writes the secret and binds. A lock whose pid
 * is dead is a crashed server's: it is removed and the link tried once more. A lock that cannot be
 * read or holds no pid is refused, not taken over: that is no proof its owner is gone. Two starts
 * that both judge the same lock stale can still both take it in turn; Claude Code starts one
 * server per session, so this is left.
 */
function takeLock(paths: BridgePaths): string | undefined {
  for (let attempt = 0; ; attempt++) {
    try {
      const draft = paths.lock + "." + process.pid;
      writeFileSync(draft, String(process.pid), { mode: 0o600 });
      try {
        linkSync(draft, paths.lock);
      } finally {
        rmSync(draft, { force: true });
      }
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return "the bridge lock " + paths.lock + " could not be created: " + message(error);
      }
    }
    let holder: number | undefined;
    try {
      const text = readFileSync(paths.lock, "utf8").trim();
      holder = /^\d+$/.test(text) ? Number(text) : undefined;
    } catch (error) {
      // Gone between the link and the read: the link below decides. Any other failure proves nothing.
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && attempt === 0) continue;
      return "the bridge lock " + paths.lock + " could not be read, so its owner may be alive: " + message(error);
    }
    if (holder === undefined) return "the bridge lock " + paths.lock + " holds no pid; remove it if no Fabric server runs for this session";
    // Another live server holds it, including one started in this same process.
    if (pidAlive(holder)) return heldMessage(paths.socket);
    // Two starts cleared the same stale lock and one took it: this one is the loser.
    if (attempt > 0) return heldMessage(paths.socket);
    try {
      unlinkSync(paths.lock);
    } catch {
      // Already gone: the create below decides.
    }
  }
}

export async function startBridge(options: BridgeOptions): Promise<BridgeStart> {
  if (options.pluginData === "") {
    return { error: "CLAUDE_PLUGIN_DATA is not set, so the Fabric mod and the server have no folder to meet in" };
  }
  if (options.sessionId === "") {
    return { error: "CLAUDE_CODE_SESSION_ID is not set, so the bridge has no socket name for this session" };
  }
  const paths = bridgePaths(options.pluginData, options.sessionId);
  const problem = bridgePathProblem(paths);
  if (problem !== undefined) return { error: problem };
  const timeoutMs = options.answerTimeoutMs ?? ANSWER_TIMEOUT_MS;
  const pollMs = options.pollMs ?? JOB_WAIT_MS;
  const receiptMs = options.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS;

  // The folder is the plugin's own, and the secret beside the socket is what keeps another local
  // process that finds the socket from draining or answering jobs.
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
  // One process serves a session. The lock holder, and only it, replaces a stale socket, writes
  // the secret and binds; a start that does not get the lock changes nothing, so a live server is
  // never unlinked or hidden behind another secret.
  const lockError = takeLock(paths);
  if (lockError !== undefined) return { error: lockError };
  try {
    unlinkSync(paths.socket);
  } catch {
    // No stale socket, or one already gone.
  }
  const secret = randomBytes(32).toString("hex");
  writeFileSync(paths.secret, secretFileText(options.sessionId, secret), { mode: 0o600 });

  let catalog: BridgeCatalog = emptyCatalog;
  let transcriptPath: string | undefined;
  const jobs: BridgeJob[] = [];
  const waiters: ((job: BridgeJob | null) => void)[] = [];
  const answers = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** Each live job's machine (proofs/job-receipt.ts): the server acts only on an event it accepts. */
  const ledger = new JobLedger();
  /** The receipt limit of each job handed out and not yet confirmed. */
  const receipts = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;
  /** When the mod last reached the socket: 0 until its first authenticated request. */
  let seenAt = 0;

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  // A job goes to a waiting poll, or waits for the next one.
  const dispatch = (job: BridgeJob): void => {
    const waiter = waiters.shift();
    if (waiter === undefined) jobs.push(job);
    else waiter(job);
  };

  /**
   * Whether the mod is there to take a job: a poll is parked right now, or one arrived within the
   * grace. A long poll holds for JOB_WAIT_MS, so the parked poll is the signal that lasts.
   */
  const modHere = (): boolean =>
    waiters.length > 0 || (seenAt !== 0 && Date.now() - seenAt <= MOD_GRACE_MS);

  /** The next job whose call is still waiting; a job whose call gave up must never be handed out. */
  const nextJob = (): BridgeJob | undefined => {
    for (;;) {
      const job = jobs.shift();
      if (job === undefined) return undefined;
      if (answers.has(job.id)) return job;
    }
  };

  const take = (signal: AbortSignal): Promise<BridgeJob | null> => new Promise((resolve) => {
    const job = nextJob();
    if (job !== undefined) {
      resolve(job);
      return;
    }
    let settled = false;
    const waiter = (value: BridgeJob | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", disconnected);
      resolve(value);
    };
    // A poll that disconnects leaves no waiter behind: a later job would go to it and be lost
    // while its caller waited for the timeout.
    const disconnected = (): void => {
      if (settled) return;
      const at = waiters.indexOf(waiter);
      if (at !== -1) waiters.splice(at, 1);
      waiter(null);
    };
    const timer = setTimeout(() => {
      const at = waiters.indexOf(waiter);
      if (at !== -1) waiters.splice(at, 1);
      waiter(null);
    }, pollMs);
    if (signal.aborted) {
      waiter(null);
      return;
    }
    signal.addEventListener("abort", disconnected, { once: true });
    waiters.push(waiter);
  });

  /** A job is on its way to the mod: the mod must confirm it before the receipt limit. */
  const handed = (id: number): void => {
    if (!ledger.step(id, "hand")) return;
    receipts.set(id, setTimeout(() => {
      receipts.delete(id);
      if (!ledger.step(id, "receiptLimit")) return;
      const slot = answers.get(id);
      if (slot === undefined) return;
      answers.delete(id);
      clearTimeout(slot.timer);
      slot.reject(new Error("the Fabric mod never confirmed job " + id + " within " + receiptMs + "ms, so it was not run"));
    }, receiptMs));
  };

  /** The mod's receipt: accepted once, for a job handed to it, and only then does the mod run it. */
  const receipt = (body: unknown): boolean => {
    const id = typeof body === "object" && body !== null ? (body as Record<string, unknown>).id : undefined;
    if (typeof id !== "number" || !ledger.step(id, "receipt")) return false;
    clearTimeout(receipts.get(id));
    receipts.delete(id);
    return true;
  };

  const answer = (body: unknown): boolean => {
    if (typeof body !== "object" || body === null) return false;
    const record = body as Record<string, unknown>;
    if (typeof record.id !== "number") return false;
    const slot = answers.get(record.id);
    if (slot === undefined) return false;
    // An answer for a job the mod never confirmed is not this job's: refuse it.
    if (!ledger.step(record.id, "answer")) return false;
    answers.delete(record.id);
    clearTimeout(slot.timer);
    if (record.ok === true) slot.resolve(record.result);
    else slot.reject(new Error(typeof record.error === "string" ? record.error : "the Fabric mod answered without a value"));
    return true;
  };

  const handle = async (req: Request): Promise<Response> => {
    if (req.headers.get(BRIDGE_HEADER) !== secret) return new Response("forbidden", { status: 403 });
    if (req.method !== "POST") return new Response("POST only", { status: 405 });
    seenAt = Date.now();
    const path = new URL(req.url).pathname;
    if (path === "/session") {
      const body: unknown = await req.json().catch(() => undefined);
      if (!isBridgeSession(body)) return json({ ok: false }, 400);
      transcriptPath = body.transcriptPath || undefined;
      return json({ ok: true });
    }
    if (path === "/catalog") {
      const body: unknown = await req.json().catch(() => undefined);
      if (!isBridgeCatalog(body)) return json({ ok: false }, 400);
      catalog = body;
      return json({ ok: true });
    }
    if (path === "/next") {
      const job = await take(req.signal);
      if (job !== null) handed(job.id);
      return json({ job });
    }
    if (path === "/receipt") return json({ ok: receipt(await req.json().catch(() => undefined)) });
    if (path === "/answer") return json({ ok: answer(await req.json().catch(() => undefined)) });
    return new Response("not found", { status: 404 });
  };

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ unix: paths.socket, fetch: handle });
  } catch (error) {
    // The lock holder wrote both, and nothing else may have them yet.
    try {
      unlinkSync(paths.secret);
    } catch {
      // Nothing to remove.
    }
    try {
      unlinkSync(paths.lock);
    } catch {
      // Nothing to remove.
    }
    return { error: "the bridge could not listen on " + paths.socket + ": " + message(error) };
  }

  let closed = false;
  const close = (): void => {
    // Once only: a second close (the signal handler, then exit) must not remove a successor's paths.
    if (closed) return;
    closed = true;
    // The lock holder owns these paths, so the stop's unlink of the socket is this instance's.
    // Then the secret goes, and the lock last: a start that sees no lock finds no half-state.
    try {
      server.stop(true);
    } catch {
      // Already stopped.
    }
    for (const slot of answers.values()) {
      clearTimeout(slot.timer);
      slot.reject(new Error("the Fabric bridge closed before the mod answered"));
    }
    answers.clear();
    for (const timer of receipts.values()) clearTimeout(timer);
    receipts.clear();
    ledger.clear();
    for (const waiter of waiters.splice(0)) waiter(null);
    jobs.length = 0;
    try {
      unlinkSync(paths.secret);
    } catch {
      // Already gone.
    }
    try {
      unlinkSync(paths.lock);
    } catch {
      // Already gone.
    }
  };

  // What a job carries once the server has numbered it: its own kind, which the mod reads to
  // decide how to run it. TypeScript cannot see that a spread of a union keeps its discriminant.
  type JobRequest = Omit<McpJob, "id"> | Omit<BuiltinJob, "id">;

  // One job to the mod, whichever kind it is, and its answer back: the queue and the answer path
  // are shared, so both calls fail the same way and neither can be handed out twice.
  const ask = (what: string, job: JobRequest): Promise<unknown> => {
    // No mod, no answer: fail now rather than after the full limit.
    if (!modHere()) {
      return Promise.reject(new Error(
        "no Fabric mod is connected in this session, so " + what + " cannot be reached (the bridge socket is " + paths.socket + ")",
      ));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        answers.delete(id);
        ledger.step(id, "answerLimit");
        clearTimeout(receipts.get(id));
        receipts.delete(id);
        // The call has given up: its job must not run later, or a retried write would repeat.
        const at = jobs.findIndex((job) => job.id === id);
        if (at !== -1) jobs.splice(at, 1);
        reject(new Error("the Fabric mod did not answer within " + timeoutMs + "ms"));
      }, timeoutMs);
      answers.set(id, { resolve, reject, timer });
      ledger.open(id);
      dispatch({ ...job, id } as BridgeJob);
    });
  };

  const bridge: Bridge = {
    paths,
    catalog: () => catalog,
    transcriptPath: () => transcriptPath,
    call: (serverName, tool, args) =>
      ask("Claude Code's MCP connections", { kind: "mcp", server: serverName, tool, args }),
    tool: (name, input) =>
      ask("Claude Code's built-in tools", { kind: "builtin", tool: name, input }),
    close,
  };
  return { bridge };
}
