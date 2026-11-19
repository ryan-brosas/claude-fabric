import { z } from "zod";
import { defineAction } from "../../registry/action.ts";

const DEFAULT_MS = 120_000;
const MAX_MS = 600_000;

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
    // started (a test runner's workers, a nested shell), not just bash -c. A child left alive
    // could keep writing after the call ended, and one holding the pipes would hang the read.
    const p = Bun.spawn(["bash", "-c", i.command], { cwd, stdout: "pipe", stderr: "pipe", detached: true });
    let timedOut = false;
    const killTree = (): void => {
      try {
        process.kill(-p.pid, "SIGKILL");
      } catch {
        // The group is already gone.
      }
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeout);
    signal?.addEventListener("abort", killTree, { once: true });
    if (signal?.aborted) killTree();
    let out: string, err: string, exitCode: number;
    try {
      [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      exitCode = await p.exited;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", killTree);
    }
    const output = out + err;
    if (timedOut) throw new Error("Bash timed out after " + timeout + "ms: " + output.slice(-2000));
    if (exitCode !== 0 && !i.allowFailure) throw new Error("Bash exited " + exitCode + ": " + output.slice(-2000));
    return { output, exitCode };
  },
});
