// The cut and the summary: Claude Code's transcript in, pi-fabric's deterministic
// summary out, with no model call. The cut is checked by the compiled machine in
// verified/cut.ts (rule and laws in proofs/cut.ts) before anything is summarized.
import { type ClaudeMessage, messageBytes, normalizeMessages } from "./from-claude.ts";
import { projectWithMetadata } from "./projections.ts";
import { renderSummary, SUMMARY_HEADER } from "./render.ts";
import { acceptCut } from "./verified/cut.ts";

export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const SKIP_NOTHING = "fabric: nothing to compact";

export interface CompactOptions {
  /** How many estimated tokens of the newest messages to keep; one token is about four UTF-8 bytes. */
  keepRecentTokens?: number;
  /** What the summary should keep or stress, as typed after /compact. */
  instructions?: string;
}

export type CompactResult =
  | { messages: ClaudeMessage[] }
  | { skip: string };

const estimatedTokens = (message: ClaudeMessage): number => Math.ceil(messageBytes(message) / 4);

/** A real prompt: a user message that carries no tool results. */
const isPromptBoundary = (message: ClaudeMessage): boolean =>
  message.role === "user" && (message.toolResults?.length ?? 0) === 0;

/**
 * A summary this compactor wrote earlier. It is cumulative source, not a user
 * prompt: read as prose it would be cut to one 2,048-byte excerpt and lose the
 * sections, so compact() carries it forward whole instead.
 */
const isFabricSummary = (message: ClaudeMessage): boolean =>
  message.role === "user"
  && (message.toolUses?.length ?? 0) === 0
  && message.text.trimStart().startsWith(SUMMARY_HEADER);

/**
 * Keep the newest messages that fit keepRecentTokens, starting only at a prompt,
 * and summarize everything older. Returns { skip } when nothing is older than the
 * kept tail, or when the transcript holds no prompt to start a tail on.
 */
export const compact = (messages: readonly ClaudeMessage[], options: CompactOptions = {}): CompactResult => {
  const keepRecentTokens = options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
  if (!Number.isSafeInteger(keepRecentTokens) || keepRecentTokens <= 0) {
    throw new RangeError(`keepRecentTokens must be a positive integer, not ${keepRecentTokens}`);
  }
  if (messages.length === 0) return { skip: SKIP_NOTHING };

  const sizes = messages.map(estimatedTokens);
  const boundaries: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (isPromptBoundary(messages[index]!)) boundaries.push(index);
  }
  if (boundaries.length === 0) return { skip: SKIP_NOTHING };

  // The oldest prompt whose whole tail still fits is the largest tail within budget.
  const suffix = new Array<number>(messages.length + 1).fill(0);
  for (let index = messages.length - 1; index >= 0; index--) {
    suffix[index] = suffix[index + 1]! + sizes[index]!;
  }
  let start = boundaries[boundaries.length - 1]!;
  for (const boundary of boundaries) {
    if (suffix[boundary]! <= keepRecentTokens) {
      start = boundary;
      break;
    }
  }
  // Nothing older than the tail: there is no summary to write.
  if (start === 0) return { skip: SKIP_NOTHING };

  const summaryIndexes = new Set<number>();
  messages.forEach((message, index) => {
    if (isFabricSummary(message)) summaryIndexes.add(index);
  });
  // A previous summary counts as the source it already is, never as new work.
  const older = messages.slice(0, start).filter((_, index) => !summaryIndexes.has(index));
  if (older.length === 0) return { skip: SKIP_NOTHING };
  let earlierSummary: string | undefined;
  for (let index = start - 1; index >= 0; index--) {
    if (!summaryIndexes.has(index)) continue;
    earlierSummary = messages[index]!.text.trimStart().slice(SUMMARY_HEADER.length).trim();
    break;
  }

  if (!acceptCut(keepRecentTokens, messages.map((message, index) => ({
    tail: index >= start,
    prompt: isPromptBoundary(message),
    bytes: sizes[index]!,
  })))) {
    throw new Error("fabric: the compaction cut failed its verified check");
  }

  // Our own summaries are carried as the [Earlier summary] block, never folded
  // back in as user prose.
  const events = normalizeMessages(messages).filter((event) => !summaryIndexes.has(Number(event.entryId)));
  const summarizedEvents = events.filter((event) => Number(event.entryId) < start);
  // Only dialogue from the kept tail is needed to pair a summarized proposal
  // with its raw user reply. Never summarize the tail's tool history.
  const retainedDialogue = events.filter((event) =>
    Number(event.entryId) >= start && (event.kind === "user" || event.kind === "assistantText"));
  const { sections } = projectWithMetadata(summarizedEvents, retainedDialogue);
  const instructions = options.instructions?.trim();
  const summary = renderSummary(sections, {
    firstEntryId: String(0),
    lastEntryId: String(start - 1),
    lastTimestamp: "",
    ...(instructions ? { requestLines: [instructions] } : {}),
    ...(earlierSummary ? { earlierSummary } : {}),
  });

  return {
    messages: [
      { role: "user", text: summary, toolUses: [] },
      ...messages.slice(start),
    ],
  };
};
