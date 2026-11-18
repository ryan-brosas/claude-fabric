// Globals a fabric_exec program sees. Phase 0 subset.
interface PiReadOptions { path: string; offset?: number; limit?: number }
interface PiGrepOptions { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; context?: number; limit?: number }
interface PiBashOptions { command: string; timeout?: number; cwd?: string; settle?: boolean }
interface PiEnvelope { ok: boolean; output: string; details: unknown; exitCode?: number | null; error?: string }
declare const pi: {
  read(path: string | PiReadOptions, options?: Omit<PiReadOptions, "path">): Promise<string>;
  grep(pattern: string | PiGrepOptions, path?: string, limit?: number): Promise<string>;
  bash(command: string | PiBashOptions, options?: Omit<PiBashOptions, "command">): Promise<PiEnvelope>;
};
declare function print(...values: unknown[]): void;
/** String payloads passed in the same call's `payloads` argument. */
declare const π: Readonly<Record<string, string>>;
