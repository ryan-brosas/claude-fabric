import { z } from "zod";
import { expand, recall } from "../../recall/history.ts";
import { defineAction } from "../../registry/action.ts";

// One schema per call drives the program declarations, DESCRIPTION and runtime argument checks.
const binding = z.object({ bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const recallInput = z.object({ query: z.string().min(1), limit: z.number().int().positive().optional(), offset: z.number().int().nonnegative().optional() });
const expandInput = z.object({ binding, entryIds: z.array(z.string().min(1)).optional(),
  range: z.object({ first: z.string().min(1), last: z.string().min(1) }).optional(),
  before: z.number().int().nonnegative().optional(), after: z.number().int().nonnegative().optional(),
  maxEntries: z.number().int().positive().optional(), maxChars: z.number().int().positive().optional(),
  entryOffset: z.number().int().nonnegative().optional(), textOffset: z.number().int().nonnegative().optional() });
const kind = z.enum(["user", "assistant", "summary", "tool_result", "tool"]);
const hit = z.object({ uuid: z.string(), kind, score: z.number(), snippet: z.string(), truncated: z.boolean(), follow: expandInput });
const Recall = defineAction({ name: "recall", doc: "Search this session's transcript. Wrap the whole query in double quotes for an exact phrase. Each hit carries follow arguments for history.expand.",
  input: recallInput, output: z.object({ binding, hits: z.array(hit), total: z.number(), unresolvable: z.array(z.string()), next: recallInput.nullable() }),
  positional: [], run: (input, ctx) => recall(ctx.transcriptPath ?? "", input) });
const Expand = defineAction({ name: "expand", doc: "Read full source text by bound UUIDs or inclusive range; next continues a page.",
  input: expandInput, output: z.object({ entries: z.array(z.object({ uuid: z.string(), kind, text: z.string(),
    textRange: z.object({ start: z.number(), end: z.number(), total: z.number(), complete: z.boolean() }) })), next: expandInput.nullable() }),
  positional: [], run: (input, ctx) => expand(ctx.transcriptPath ?? "", input) });
export const HISTORY = [Recall, Expand];
