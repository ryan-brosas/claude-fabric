// WebSearch as a program tool: the surface the registry prints from its one definition, the
// arguments it checks, and the value a program gets back from the mod's answer. Nothing here
// searches the web.
import { describe, expect, test } from "bun:test";
import { TOOLS } from "../../src/providers/tools/index.ts";
import { WebSearch, webSearchValue } from "../../src/providers/tools/websearch.ts";
import type { BuiltinToolLink } from "../../src/registry/action.ts";
import { guestTypes, parseArgs, toolLines } from "../../src/registry/generate.ts";

interface Sent { tool: string; input: Record<string, unknown> }

/** What Claude Code's WebSearch returns, as the probe read it: a hit list per source call. */
const ANSWER = {
  result: {
    query: "pi fabric",
    results: [
      {
        tool_use_id: "toolu_1",
        content: [
          { title: "pi-fabric", url: "https://github.com/fabric-runtime/pi-fabric", snippet: "A runtime for Pi." },
          { title: "Fabric docs", url: "https://example.com/docs" },
        ],
      },
      { tool_use_id: "toolu_2", content: [] },
      "a string entry, which names no hit",
    ],
    durationSeconds: 1.4,
    searchCount: 2,
  },
  text: "Found pi-fabric and its docs.",
};

function link(answer: unknown = ANSWER): { value: BuiltinToolLink; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    value: {
      call: async (tool, input) => {
        sent.push({ tool, input });
        return answer;
      },
    },
  };
}

const run = (input: { query: string; allowed_domains?: string[]; blocked_domains?: string[]; mode?: "standard" | "extended" }, builtin?: BuiltinToolLink) =>
  WebSearch.run(input, { cwd: "/work", builtin });

describe("the surface the registry prints", () => {
  test("declares Claude Code's own name and fields, with the one-string shorthand", () => {
    const text = guestTypes([WebSearch]);
    expect(text).toContain("interface WebSearchInput {");
    expect(text).toContain("  query: string;");
    expect(text).toContain("  allowed_domains?: string[];");
    expect(text).toContain("  blocked_domains?: string[];");
    expect(text).toContain('  mode?: "standard" | "extended";');
    expect(text).toContain("interface WebSearchResult {");
    expect(text).toContain("  text: string;");
    expect(text).toContain("declare function WebSearch(input: string | WebSearchInput): Promise<WebSearchResult>;");
  });

  test("prints one tool line naming every field", () => {
    expect(toolLines([WebSearch])).toEqual([
      '- WebSearch({query, allowed_domains?, blocked_domains?, mode?}) -> {text, results}. ' + WebSearch.doc,
    ]);
    expect(TOOLS.map((action) => action.name)).toContain("WebSearch");
  });

  test("checks its arguments like any other tool", () => {
    expect(parseArgs(WebSearch, ["pi fabric"])).toEqual({ query: "pi fabric" });
    expect(parseArgs(WebSearch, [{ query: "pi", mode: "extended", allowed_domains: ["github.com"] }]))
      .toEqual({ query: "pi", mode: "extended", allowed_domains: ["github.com"] });
    expect(() => parseArgs(WebSearch, [])).toThrow("WebSearch: query is required (string)");
    expect(() => parseArgs(WebSearch, [{ query: "pi", mode: "thorough" }])).toThrow("WebSearch: mode ");
  });
});

describe("what a program receives", () => {
  test("the answer's text, and the hits flattened out of its result", () => {
    expect(webSearchValue(ANSWER)).toEqual({
      text: "Found pi-fabric and its docs.",
      results: [
        { title: "pi-fabric", url: "https://github.com/fabric-runtime/pi-fabric", snippet: "A runtime for Pi." },
        { title: "Fabric docs", url: "https://example.com/docs" },
      ],
    });
  });

  test("an answer of no known shape is empty text and no hits, not a crash", () => {
    for (const answer of [undefined, null, "text", {}, { result: { results: "nope" } }, { result: { results: [null, { content: [{}] }] } }]) {
      expect({ answer, value: webSearchValue(answer) }).toEqual({ answer, value: { text: "", results: [] } });
    }
    expect(webSearchValue({ text: "only text", result: { results: [{ content: [{ title: "t", url: "u", snippet: 3 }] }] } }))
      .toEqual({ text: "only text", results: [{ title: "t", url: "u" }] });
  });

  test("sends one WebSearch job, with mode standard when it is left out", async () => {
    const fake = link();
    expect(await run({ query: "pi fabric" }, fake.value)).toEqual(webSearchValue(ANSWER));
    expect(fake.sent).toEqual([{ tool: "WebSearch", input: { query: "pi fabric", mode: "standard" } }]);
  });

  test("passes the domains and the mode the program asked for", async () => {
    const fake = link();
    await run({ query: "pi", allowed_domains: ["github.com"], blocked_domains: ["spam.example"], mode: "extended" }, fake.value);
    expect(fake.sent).toEqual([{
      tool: "WebSearch",
      input: { query: "pi", mode: "extended", allowed_domains: ["github.com"], blocked_domains: ["spam.example"] },
    }]);
  });

  test("a run with no bridge says built-in tools need the mod", async () => {
    await expect(run({ query: "pi" })).rejects.toThrow("WebSearch: Claude Code's built-in tools need the Fabric mod");
  });

  test("a job the mod refuses rejects inside the program", async () => {
    const refusing: BuiltinToolLink = { call: () => Promise.reject(new Error("no Fabric mod is connected in this session")) };
    await expect(run({ query: "pi" }, refusing)).rejects.toThrow("no Fabric mod is connected in this session");
  });
});
