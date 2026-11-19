// The server's way out: every command group still running is stopped before it exits.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bash, stopAllShells } from "../../src/providers/tools/bash.ts";

test("stopAllShells stops a command that no run owns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-stopall-"));
  try {
    const survived = join(dir, "survived.txt");
    const pending = Bash.run({ command: "sleep 1; touch " + survived }, { cwd: dir }).catch(() => "stopped");
    await Bun.sleep(100);
    stopAllShells();
    await pending;
    await Bun.sleep(1_200);
    expect(await Bun.file(survived).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Sol on #34: a finished command's group id must not stay armed after the group is empty.
test("a finished command with nothing left in its group is released at once", async () => {
  const ended = new AbortController();
  const kill = process.kill;
  const signaled: number[] = [];
  process.kill = ((pid: number, sig?: string | number) => {
    if (sig === "SIGKILL") signaled.push(pid);
    return kill(pid, sig as any);
  }) as typeof process.kill;
  try {
    expect((await Bash.run({ command: "true" }, { cwd: process.cwd(), signal: ended.signal })).exitCode).toBe(0);
    ended.abort();
    expect(signaled).toEqual([]);
  } finally {
    process.kill = kill;
  }
});
