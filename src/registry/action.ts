import type { z } from "zod";

/** The way a tool that runs inside Claude Code reaches the mod: one job, and its raw answer. */
export interface BuiltinToolLink {
  call(tool: string, input: Record<string, unknown>): Promise<unknown>;
}

// What a program tool's run() may use besides its own input.
export interface ActionContext {
  cwd: string;
  /** This session’s transcript path, published by the mod. */
  transcriptPath?: string;
  /** Claude Code's built-in tools, gated by the host's allowlist. Absent when the run has no bridge. */
  builtin?: BuiltinToolLink;
  /** Aborted when the run ends, by its done, an error or its time limit: a process a call started stops with it. */
  signal?: AbortSignal;
}

// One program tool, defined once. Guest types, the model-facing description and the runtime
// argument check are all generated from this (see generate.ts).
export interface Action<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>, O extends z.ZodType = z.ZodType> {
  name: string;
  /** One or two plain sentences: what the tool does, and the fields a program should know about. */
  doc: string;
  input: S;
  /** What run() resolves to. */
  output: O;
  /** Input field names for the shorthand, in call order. One name means the main field. */
  positional: string[];
  run: (input: z.output<S>, ctx: ActionContext) => Promise<z.output<O>>;
}

/** An action whose exact schemas are not known, as a list of tools holds them. */
export type AnyAction = Action<z.ZodObject<z.ZodRawShape>, z.ZodType>;

export function defineAction<S extends z.ZodObject<z.ZodRawShape>, O extends z.ZodType>(spec: Action<S, O>): Action<S, O> {
  return spec;
}
