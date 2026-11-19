#!/usr/bin/env bun
// claude-fabric MCP server: exposes one tool, fabric_exec.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { BuiltinLink } from "../kernel/builtin.ts";
import { startBridge } from "../kernel/bridge/server.ts";
import { run } from "../kernel/host.ts";
import type { McpLink } from "../kernel/mcp.ts";
import { MAX_RESULT_CHARS } from "../kernel/result.ts";
import { Store } from "../kernel/store.ts";
import { callTimeoutMs } from "../kernel/verified/call-timeout.ts";
import { STORE } from "../providers/store/index.ts";
import { TOOLS } from "../providers/tools/index.ts";
import { globalLines, toolLines } from "../registry/generate.ts";
import { MCP_INTRO, MCP_LINE } from "../registry/mcp.ts";
import { prepareArguments } from "../stages/args.ts";
import { RepeatGuard } from "../stages/repeat-guard.ts";

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// One guard and one store per server process, and a server process is one session.
const guard = new RepeatGuard();
const store = new Store();

// The socket to the mod. Claude Code gives the server this session's id and the plugin's data
// folder; the mod reads the same two and meets it here. Without them, or with a path too long for
// a Unix socket, an mcp call says why instead of waiting.
const started = await startBridge({
  pluginData: process.env.CLAUDE_PLUGIN_DATA ?? "",
  sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? "",
});

const mcp: McpLink = "bridge" in started ? started.bridge : {
  catalog: () => ({ servers: [] }),
  call: () => Promise.reject(new Error("the bridge is not running")),
  error: started.error,
};

// The same bridge carries a built-in tool job; without one, WebSearch says why instead of waiting.
const builtin: BuiltinLink = "bridge" in started ? started.bridge : {
  tool: () => Promise.reject(new Error("the bridge is not running")),
  error: started.error,
};

const INTRO = "Run one type-checked TypeScript program that calls tools and returns one result. Use it for file reads, searches, shell commands, and any multi-step or parallel work, instead of many separate tool calls.\n\nThe program is an async function body: top-level await and return work. Only the returned value and print() output reach you; intermediate data stays in the program. Each call runs in a fresh worker, and the store below is the only state that carries to the next one.\n\nTools inside the program (same names and fields as Claude Code's tools; a single string means the main field):";

// The store globals are not tools: nothing crosses the bridge for them.
const STORE_INTRO = "\nThe session's store, shared by every fabric_exec call in this session (globals, not tools):";

// The mcp surface comes from the session's catalog; the line says it exists without listing it.
const MCP_INTRO_LINE = "\n" + MCP_INTRO;

// The tool lines come from the actions themselves; this prose is about the program as a whole.
const OUTRO = [
  "",
  "- print(...values) adds a line to the output.",
  "- π.<key> reads a string from this call's payloads argument. Put long or syntax-heavy text there instead of in code.",
  "- A program that fails, times out or crashes commits no store() writes.",
  "- A program runs for at most 120 s. For a long build or test suite, set this call's timeout (ms, up to 600000).",
  "",
  "Run independent calls together in one Promise.all. In a large file, find lines with Grep, then Read only that range; don't cat files through Bash. Return only what the next step needs, not raw output. A type error stops the program before it runs and lists line numbers; fix it and call again.",
];

export const DESCRIPTION = [INTRO, ...toolLines(TOOLS), MCP_INTRO_LINE, MCP_LINE, STORE_INTRO, ...globalLines(STORE), ...OUTRO].join("\n");

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
  timeout: z.number().nullish().describe("Milliseconds this program may run: default 120000, at most 600000."),
});

// The envelope after repair: one program string, an optional payload record, an optional label.
const ENVELOPE = z.object({
  code: z.string().min(1),
  payloads: z.record(z.string(), z.string()).optional(),
  display: z.object({ name: z.string().optional(), description: z.string().optional() }).optional(),
  timeout: z.number().int().positive().optional(),
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
  if (field === "timeout") return "fabric_exec: timeout must be a whole number of ms, like 300000; the most is 600000.";
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
      // The limit is the compiled machine of proofs/call-timeout.ts: default 120000, never over 600000.
      const timeoutMs = callTimeoutMs(parsed.data.timeout);
      const result = await run(parsed.data.code, cwd, { payloads: parsed.data.payloads, timeoutMs, guard, store, mcp, builtin });
      return { content: [{ type: "text", text: bounded(result.text) }], isError: !result.ok };
    },
  );
  return server;
}

if (import.meta.main) {
  if ("bridge" in started) {
    const bridge = started.bridge;
    const close = (): void => bridge.close();
    process.on("exit", close);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { close(); process.exit(0); });
  } else {
    // stderr, never stdout: stdout is the MCP stream.
    console.error("fabric: " + started.error + "; mcp.<server>.<tool>() and WebSearch will refuse");
  }
  await createServer().connect(new StdioServerTransport());
}
