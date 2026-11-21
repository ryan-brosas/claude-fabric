// Independently rank exact values directly from source messages. Extraction and
// secret filtering are shared lexical rules, not the renderer's selection.
import { hasOutcome, inlineOutcome, type ClaudeMessage } from "./from-claude.ts";
import { carriedValues, userExcerpts, valuesIn, type ExactValue } from "./literals.ts";

export interface LiteralSource {
  messages: readonly ClaudeMessage[];
  start: number;
  earlierSummary: string;
  summaryIndexes: ReadonlySet<number>;
}

interface Fact extends ExactValue {
  position: number;
  order: number;
  error: boolean;
  errorCode: boolean;
  missingUser: boolean;
  userOrder: number;
  shown: boolean;
}

const errorCode = (value: string): boolean => /^[A-Z][A-Z_]*\d{3,}\b/.test(value);

export const sourceLiterals = (source: LiteralSource, wholeUsers: ReadonlySet<string>, protectedText: string): ExactValue[] => {
  const { messages, start, earlierSummary, summaryIndexes } = source;
  const facts: Fact[] = carriedValues(earlierSummary).map((value, order) => ({
    ...value, position: -1, order, error: errorCode(value.value), errorCode: errorCode(value.value),
    missingUser: !valuesIn(value.value).includes(value.value), userOrder: order, shown: protectedText.includes(value.value),
  }));
  const rows = new Map<string, Set<string>>();
  const inline = new Map<string, ReturnType<typeof inlineOutcome>>();
  for (const message of messages.slice(0, start)) {
    for (const result of message.toolResults ?? []) {
      const texts = rows.get(result.tool_use_id) ?? new Set<string>();
      texts.add(result.text);
      rows.set(result.tool_use_id, texts);
    }
    for (const use of message.toolUses ?? []) if (hasOutcome(use)) inline.set(use.tool_use_id, inlineOutcome(use));
  }
  const add = (values: readonly string[], entryId: string, position: number, error: boolean, missingUser = false): void => {
    values.forEach((value, index) => facts.push({ entryId, value, position, order: facts.length,
      error: error || errorCode(value), errorCode: errorCode(value), missingUser,
      userOrder: values.length - index - 1, shown: protectedText.includes(value) }));
  };
  const lastDialogue = new Map<string, number>();
  messages.forEach((message, position) => {
    const isSummary = summaryIndexes.has(position);
    const dialogue = message.text && !isSummary ? valuesIn(message.text) : [];
    for (const value of dialogue) lastDialogue.set(value, position);
    if (position >= start || isSummary) return;
    const id = message.handle ?? message.uuid;
    if (!id) throw new Error("fabric: a message has no source handle for recall");
    if (message.role === "assistant") add(dialogue, id, position, false);
    else if (message.text) add(userExcerpts(message.text), id, position, false, !wholeUsers.has(id));
    for (const use of message.toolUses ?? []) {
      if (use.text && !rows.get(use.tool_use_id)?.has(use.text)) add(valuesIn(use.text), id, position, use.isError === true);
    }
    for (const result of message.toolResults ?? []) {
      const outcome = inline.get(result.tool_use_id);
      if (!outcome || outcome.text === result.text) add(valuesIn(result.text), id, position, outcome?.isError ?? result.isError);
    }
  });
  const echoed = (fact: Fact): boolean => (lastDialogue.get(fact.value) ?? -1) > fact.position;
  const priority = (fact: Fact): number => {
    const salient = echoed(fact) || fact.error;
    if (!fact.shown && (fact.missingUser || salient)) return 0;
    if (salient) return 1;
    return fact.missingUser ? 2 : 3;
  };
  facts.sort((a, b) => {
    const order = priority(a) - priority(b) || Number(echoed(b)) - Number(echoed(a)) || Number(b.errorCode) - Number(a.errorCode)
      || Number(b.error) - Number(a.error) || Number(b.missingUser) - Number(a.missingUser);
    if (order) return order;
    return a.missingUser ? a.userOrder - b.userOrder || b.position - a.position || b.order - a.order
      : b.position - a.position || b.order - a.order;
  });
  const seen = new Set<string>();
  return facts.filter(({ value }) => !seen.has(value) && !!seen.add(value)).map(({ entryId, value }) => ({ entryId, value }));
};
