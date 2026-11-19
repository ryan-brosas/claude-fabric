// Adapted from pi-fabric (MIT, Tom X Nguyen) src/type-error-guidance.ts at d331f629; the tool
// list and every tool's fields arrive as data instead of being derived from Pi's declarations, the
// hints name Claude Code's tools, and the shell/interpolation notes are dropped because neither
// applies here.

// The check reports "line L:C message"; an error with no position is the message alone.
const ISSUE = /^line \d+:\d+ ([\s\S]*)$/;
const UNKNOWN_PROPERTY = /'([^']+)' does not exist in type '([^']+)'/;
const MISSING_NAME = /Cannot find name '([^']+)'/;
const PROMISE_ALL = /\bPromise\.all\s*\(/;
const TUPLE_ARITY = /Tuple type .* of length '\d+' has no element at index '\d+'/;

/** The envelope keys a model most often puts inside a program by mistake. */
const ENVELOPE_KEYS = new Set(["payloads", "display"]);

/** Names a program has no way to reach; the tools are what it has instead. */
const MISSING_NAMES = new Set(["pi", "fs", "require", "process"]);

/** One program tool as the hints may describe it: its name and the fields its input takes. */
export interface GuidanceTool {
  name: string;
  fields: readonly string[];
}

const envelopeHint = (key: string): string =>
  key === "payloads"
    ? "Recovery hint: `payloads` is a fabric_exec argument, not a program tool field. Send it beside `code`; a program reads it as π.<key>."
    : "Recovery hint: `display` is a fabric_exec argument, not a program tool field. Send it beside `code`.";

const toolForType = (typeText: string, tools: readonly GuidanceTool[]): GuidanceTool | undefined =>
  tools.find((tool) => new RegExp("\\b" + tool.name + "Input\\b").test(typeText));

const unknownPropertyHint = (message: string, tools: readonly GuidanceTool[]): string | undefined => {
  const match = UNKNOWN_PROPERTY.exec(message);
  if (!match) return undefined;
  const property = match[1];
  const typeText = match[2];
  if (property === undefined || typeText === undefined) return undefined;
  if (ENVELOPE_KEYS.has(property)) return envelopeHint(property);
  const tool = toolForType(typeText, tools);
  if (!tool) return undefined;
  const fields = tool.fields.map((field) => "`" + field + "`").join(", ");
  return "Recovery hint: `" + property + "` is not a `" + tool.name + "` field. " + tool.name + " takes: " + fields + ".";
};

const missingNameHint = (message: string, tools: readonly GuidanceTool[]): string | undefined => {
  const name = MISSING_NAME.exec(message)?.[1];
  if (name === undefined) return undefined;
  if (ENVELOPE_KEYS.has(name)) return envelopeHint(name);
  if (!MISSING_NAMES.has(name)) return undefined;
  const names = tools.map((tool) => "`" + tool.name + "`").join(", ");
  return name === "pi"
    ? "Recovery hint: the program tools are globals called directly: " + names + ". There is no namespace object in front of them."
    : "Recovery hint: a program has no `fs`, `require` or `process`. Files, searches and commands go through " + names + ".";
};

/**
 * Short hints to print under a failed check's errors, in the order they were met. Each one names
 * the fix a model would otherwise spend a round trip finding; the check's own lines stay first.
 */
export function typeErrorGuidance(code: string, errors: readonly string[], tools: readonly GuidanceTool[]): string[] {
  const hints: string[] = [];
  const add = (hint: string | undefined): void => {
    if (hint !== undefined && !hints.includes(hint)) hints.push(hint);
  };
  for (const error of errors) {
    const message = ISSUE.exec(error)?.[1] ?? error;
    add(unknownPropertyHint(message, tools));
    add(missingNameHint(message, tools));
  }
  if (PROMISE_ALL.test(code) && errors.some((error) => TUPLE_ARITY.test(error))) {
    add("Recovery hint: `Promise.all` destructuring takes one binding per promise; remove the extra binding or add the missing call.");
  }
  return hints;
}
