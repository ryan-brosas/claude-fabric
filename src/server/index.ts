#!/usr/bin/env bun
// claude-fabric MCP server: exposes one tool, fabric_exec.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { run } from "../kernel/host.ts";
import { TOOLS } from "../providers/tools/index.ts";
import { toolLines } from "../registry/generate.ts";

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const INTRO = "Run one type-checked TypeScript program that calls tools and returns one result. Use it for file reads, searches, shell commands, and any multi-step or parallel work, instead of many separate tool calls.\n\nThe program is an async function body: top-level await and return work. Only the returned value and print() output reach you; intermediate data stays in the program. Each call starts fresh.\n\nTools inside the program (same names and fields as Claude Code's tools; a single string means the main field):";

// The tool lines come from the actions themselves; this prose is about the program as a whole.
const OUTRO = [
  "- print(...values) adds a line to the output.",
  "- π.<key> reads a string from this call's payloads argument. Put long or syntax-heavy text there instead of in code.",
  "",
  "Run independent calls together with Promise.all. Search before reading, then read only the range you need. A type error stops the program before it runs and lists line numbers; fix it and call again.",
];

export const DESCRIPTION = [INTRO, ...toolLines(TOOLS), ...OUTRO].join("\n");

export function createServer(): McpServer {
  const server = new McpServer({ name: "claude-fabric", version: "0.1.0" });
  server.registerTool(
    "fabric_exec",
    {
      title: "Fabric",
      description: DESCRIPTION,
      inputSchema: {
        code: z.string().describe("TypeScript async function body. Return the result."),
        payloads: z.record(z.string(), z.string()).optional().describe("Named strings the program reads as π.<key>."),
        display: z.object({ name: z.string().optional(), description: z.string().optional() }).passthrough().optional()
          .describe("Short label for this program."),
      },
    },
    async ({ code, payloads }) => {
      const result = await run(code, cwd, { payloads });
      return { content: [{ type: "text", text: result.text }], isError: !result.ok };
    },
  );
  return server;
}

if (import.meta.main) {
  await createServer().connect(new StdioServerTransport());
}
