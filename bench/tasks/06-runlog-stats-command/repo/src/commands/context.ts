import type { Io } from "../io";

export interface CommandContext {
  args: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  io: Io;
}
