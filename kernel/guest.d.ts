// Globals a fabric_exec program sees. Names and fields follow Claude Code's own tools.
interface ReadInput { file_path: string; offset?: number; limit?: number }
interface WriteInput { file_path: string; content: string }
interface EditInput { file_path: string; old_string: string; new_string: string; replace_all?: boolean }
interface GrepInput {
  pattern: string; path?: string; glob?: string; type?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  "-i"?: boolean; "-n"?: boolean; "-A"?: number; "-B"?: number; "-C"?: number; head_limit?: number;
}
interface GlobInput { pattern: string; path?: string }
interface BashInput { command: string; timeout?: number; description?: string; allowFailure?: boolean }
interface BashResult { output: string; exitCode: number }

/** Read a file. Output is numbered like `cat -n`; at most 2000 lines per call. */
declare function Read(input: string | ReadInput): Promise<string>;
/** Create or overwrite a file. */
declare function Write(input: WriteInput): Promise<string>;
declare function Write(file_path: string, content: string): Promise<string>;
/** Replace old_string with new_string. old_string must match exactly once unless replace_all. */
declare function Edit(input: EditInput): Promise<string>;
declare function Edit(file_path: string, old_string: string, new_string: string): Promise<string>;
/** ripgrep. Default output_mode is "files_with_matches". */
declare function Grep(input: string | GrepInput): Promise<string>;
/** Files matching a glob, newest first. */
declare function Glob(input: string | GlobInput): Promise<string[]>;
/** Run a shell command. Rejects on a nonzero exit unless allowFailure is true. timeout is in ms. */
declare function Bash(input: string | BashInput): Promise<BashResult>;
/** Adds a line to the output. */
declare function print(...values: unknown[]): void;
/** String payloads passed in the same call's `payloads` argument. */
declare const π: Readonly<Record<string, string>>;
