import { addCommand } from "./commands/add";
import type { CommandContext } from "./commands/context";
import { listCommand } from "./commands/list";
import type { Io } from "./io";

export interface CliDeps {
  env?: Record<string, string | undefined>;
  cwd?: string;
  io?: Io;
}

export const HELP = [
  "runlog - task run log",
  "",
  "usage: runlog <command> [options]",
  "",
  "commands:",
  "  add <task> [ok|failed|skipped] [durationMs]   append a run",
  "  list                                          print every run",
  "  help                                          print this text",
].join("\n");

export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
  const io = deps.io ?? {
    out: (text: string) => console.log(text),
    err: (text: string) => console.error(text),
  };
  const [command, ...args] = argv;
  const context: CommandContext = {
    args,
    env: deps.env ?? process.env,
    cwd: deps.cwd ?? process.cwd(),
    io,
  };

  switch (command) {
    case "add":
      return await addCommand(context);
    case "list":
      return await listCommand(context);
    case "help":
    case undefined:
      io.out(HELP);
      return 0;
    default:
      io.err(`unknown command "${command}"`);
      io.err(HELP);
      return 2;
  }
}
