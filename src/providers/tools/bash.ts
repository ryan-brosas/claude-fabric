import { z } from "zod";
import { defineAction } from "../../registry/action.ts";

const DEFAULT_MS = 120_000;
const MAX_MS = 600_000;
const POSIX = process.platform !== "win32";

// Every process group a Bash call started and nobody has stopped yet. Detached groups do not get
// the terminal's Ctrl-C, so the server stops them all on its way out (stopAllShells).
const live = new Set<() => void>();

/** The one way to stop a command: once, and never again after, so a reused group id is never hit. */
function owned(p: Bun.Subprocess): () => void {
  let done = false;
  const stop = (): void => {
    if (done) return;
    done = true;
    live.delete(stop);
    try {
      if (POSIX) process.kill(-p.pid, "SIGKILL");
      else p.kill("SIGKILL");
    } catch {
      // The group is already gone.
    }
  };
  live.add(stop);
  return stop;
}

/** Stops every command still running: the server calls this before it exits. */
export function stopAllShells(): void {
  for (const stop of [...live]) stop();
}

export const Bash = defineAction({
  name: "Bash",
  doc: "Run a shell command. timeout is in ms. Rejects on a nonzero exit unless allowFailure: true.",
  input: z.object({
    command: z.string().min(1).describe("The shell command."),
    timeout: z.number().optional().describe("Milliseconds before the command is killed."),
    description: z.string().optional().describe("What the command does."),
    allowFailure: z.boolean().optional().describe("Return a nonzero exit instead of rejecting."),
  }),
  output: z.object({ output: z.string(), exitCode: z.number() }),
  positional: ["command"],
  run: async (i, { cwd, signal }) => {
    const timeout = Math.min(Number(i.timeout ?? DEFAULT_MS), MAX_MS);
    // Its own process group, so a timeout or the end of the run kills everything the command
    // started (a test runner's workers, a nested shell, a child left in the background), not just
    // bash -c. A child left alive could keep writing after the call ended, and one holding the pipes
    // would hang the read. Windows has no process groups: there only the shell itself is stopped.
    const p = Bun.spawn(["bash", "-c", i.command], { cwd, stdout: "pipe", stderr: "pipe", detached: POSIX });
    let timedOut = false;
    const stop = owned(p);
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    // The group is the run's until the run ends: a child the command left in the background dies then.
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    let out: string, err: string, exitCode: number;
    try {
      [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      exitCode = await p.exited;
    } finally {
      clearTimeout(timer);
    }
    const output = out + err;
    if (timedOut) throw new Error("Bash timed out after " + timeout + "ms: " + output.slice(-2000));
    if (exitCode !== 0 && !i.allowFailure) throw new Error("Bash exited " + exitCode + ": " + output.slice(-2000));
    return { output, exitCode };
  },
});
