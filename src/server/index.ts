#!/usr/bin/env bun
// claude-fabric MCP server: exposes one tool, fabric_exec.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { run } from "../kernel/host.ts";
import { MAX_RESULT_CHARS } from "../kernel/result.ts";
import { TOOLS } from "../providers/tools/index.ts";
import { toolLines } from "../registry/generate.ts";
import { prepareArguments } from "../stages/args.ts";
import { RepeatGuard } from "../stages/repeat-guard.ts";

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// One guard per server process, and a server process is one session.
const guard = new RepeatGuard();

const INTRO = "Run one type-checked TypeScript program that calls tools and returns one result. Use it for file reads, searches, shell commands, and any multi-step or parallel work, instead of many separate tool calls.\n\nThe program is an async function body: top-level await and return work. Only the returned value and print() output reach you; intermediate data stays in the program. Each call starts fresh.\n\nTools inside the program (same names and fields as Claude Code's tools; a single string means the main field):";

// The tool lines come from the actions themselves; this prose is about the program as a whole.
const OUTRO = [
  "- print(...values) adds a line to the output.",
  "- π.<key> reads a string from this call's payloads argument. Put long or syntax-heavy text there instead of in code.",
  "",
  "Run independent calls together with Promise.all. Search before reading, then read only the range you need. A type error stops the program before it runs and lists line numbers; fix it and call again.",
];

export const DESCRIPTION = [INTRO, ...toolLines(TOOLS), ...OUTRO].join("\n");

// The shape the model may send. Deliberately loose: a program as an array of lines, payloads as
// JSON text, a display label as a bare string and null optional fields are all repaired by
// prepareArguments, so the advertised schema has to admit them or the repair never runs.
const INPUT = z.looseObject({
  code: z.union([z.string(), z.array(z.string())]).describe("TypeScript async function body. Return the result."),
  payloads: z.union([z.record(z.string(), z.string()), z.string()]).nullish().describe("Named strings the program reads as π.<key>."),
  display: z.union([
    z.string(),
    z.object({ name: z.string().optional(), description: z.string().optional() }).passthrough(),
  ]).nullish().describe("Short label for this program."),
});

// The envelope after repair: one program string, an optional payload record, an optional label.
const ENVELOPE = z.object({
  code: z.string().min(1),
  payloads: z.record(z.string(), z.string()).optional(),
  display: z.object({ name: z.string().optional(), description: z.string().optional() }).optional(),
});

// Every text this server returns passes the one cap. The result is already bounded by the host;
// this is the guard that an error path cannot be a way around it.
const bounded = (text: string): string => (text.length <= MAX_RESULT_CHARS ? text : text.slice(0, MAX_RESULT_CHARS));

// The first thing wrong with a call that survived the repair, in the tool's own words. Only the
// top-level field name is echoed: a key inside payloads is model input and can be any length.
function envelopeError(error: z.ZodError): string {
  const first = error.issues[0];
  const field = first?.path.length ? String(first.path[0]) : "";
  if (field === "code") return "fabric_exec: code must be one TypeScript program string, or an array of lines; empty code is not a call.";
  if (field === "payloads") return 'fabric_exec: payloads must be an object of strings, like {"name": "text"}, or a JSON object string.';
  return "fabric_exec: " + (field || "arguments") + ": " + (first?.message ?? "invalid argument");
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "claude-fabric", version: "0.1.0" });
  server.registerTool(
    "fabric_exec",
    {
      title: "Fabric",
      description: DESCRIPTION,
      inputSchema: INPUT,
    },
    async (raw) => {
      const parsed = ENVELOPE.safeParse(prepareArguments(raw));
      if (!parsed.success) return { content: [{ type: "text", text: bounded(envelopeError(parsed.error)) }], isError: true };
      const result = await run(parsed.data.code, cwd, { payloads: parsed.data.payloads, guard });
      return { content: [{ type: "text", text: bounded(result.text) }], isError: !result.ok };
    },
  );
  return server;
}

if (import.meta.main) {
  await createServer().connect(new StdioServerTransport());
}
