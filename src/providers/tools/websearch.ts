import { z } from "zod";
import { defineAction } from "../../registry/action.ts";

// WebSearch runs in Claude Code, not here: the program's call becomes one job over the socket and
// the mod runs it with `$.tool.call`, which skips the person's permission prompts and deny rules.
// So the tool keeps Claude Code's own name and fields, the allowlist in src/bridge/contract.ts is
// the only list that can reach it, and the host's access rule (src/kernel/builtin.ts) sends a job
// only through its verdict.

/** One search hit, as Claude Code gives it: a title, a URL, and sometimes a snippet. */
export interface WebSearchHit {
  title: string;
  url: string;
  snippet?: string;
}

/** What a program receives: the text the model would read, and the hits behind it. */
export interface WebSearchValue {
  text: string;
  results: WebSearchHit[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The program's value from what `$.tool.call` answered: its `text`, and the hits flattened out
 * of `result.results`. A result entry may be a string instead of a hit list, and a hit may carry
 * no snippet; anything else is left out rather than guessed at.
 */
export function webSearchValue(answer: unknown): WebSearchValue {
  const record = isObject(answer) ? answer : {};
  const text = typeof record.text === "string" ? record.text : "";
  const result = isObject(record.result) ? record.result : {};
  const results: WebSearchHit[] = [];
  for (const entry of Array.isArray(result.results) ? result.results : []) {
    if (!isObject(entry) || !Array.isArray(entry.content)) continue;
    for (const block of entry.content) {
      if (!isObject(block) || typeof block.title !== "string" || typeof block.url !== "string") continue;
      results.push(typeof block.snippet === "string"
        ? { title: block.title, url: block.url, snippet: block.snippet }
        : { title: block.title, url: block.url });
    }
  }
  return { text, results };
}

export const WebSearch = defineAction({
  name: "WebSearch",
  doc: "Search the web. Returns Claude Code's answer text and the hits behind it. mode defaults to \"standard\"; \"extended\" costs several times more.",
  input: z.object({
    query: z.string().min(1).describe("The search query."),
    allowed_domains: z.array(z.string()).optional().describe("Only results from these domains."),
    blocked_domains: z.array(z.string()).optional().describe("Never results from these domains."),
    mode: z.enum(["standard", "extended"]).optional().describe('"standard" is the normal search; "extended" is a thorough, fresh search at several times the cost.'),
  }),
  output: z.object({
    text: z.string(),
    results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string().optional() })),
  }),
  positional: ["query"],
  run: async (i, { builtin }) => {
    if (builtin === undefined) {
      throw new Error("WebSearch: Claude Code's built-in tools need the Fabric mod, and this run has no bridge to it");
    }
    const input: Record<string, unknown> = { query: i.query, mode: i.mode ?? "standard" };
    if (i.allowed_domains !== undefined) input.allowed_domains = i.allowed_domains;
    if (i.blocked_domains !== undefined) input.blocked_domains = i.blocked_domains;
    return webSearchValue(await builtin.call("WebSearch", input));
  },
});
