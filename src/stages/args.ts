// Adapted from pi-fabric (MIT, Tom X Nguyen) src/fabric-exec-arguments.ts at d331f629; keeps only
// the envelope repairs: the Pi-only keys and the @options directive are dropped, program code repair
// lives in code-repair.ts, and a bare string or a string[] program is accepted.

// Keys pi-fabric's tool accepted that this one does not declare. Dropping them turns a call a model
// learned elsewhere into an honest one instead of a rejected envelope.
const PI_ONLY_KEYS = [
  "tokenBudget",
  "agentBudget",
  "resultFormat",
  "background",
  "max_output_tokens",
] as const;

// The optional keys. A null one is absent, not invalid.
const OPTIONAL_KEYS = ["payloads", "strings", "display"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const looksLikeJsonObject = (text: string): boolean => text.startsWith("{") && text.endsWith("}");

const looksLikeJsonString = (text: string): boolean => text.startsWith('"') && text.endsWith('"');

const parseJsonObject = (text: string): Record<string, unknown> | undefined => {
  const trimmed = text.trim();
  if (!looksLikeJsonObject(trimmed) && !looksLikeJsonString(trimmed)) return undefined;
  try {
    let parsed: unknown = JSON.parse(trimmed);
    // One extra unwrap: models sometimes JSON-encode the object twice.
    if (typeof parsed === "string") {
      const inner = parsed.trim();
      if (!looksLikeJsonObject(inner)) return undefined;
      parsed = JSON.parse(inner);
    }
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const asStringRecord = (record: Record<string, unknown>): Record<string, string> | undefined => {
  if (Object.values(record).some((value) => typeof value !== "string")) return undefined;
  return record as Record<string, string>;
};

/**
 * The payload map, whether it arrived as a record or as JSON text (possibly double-encoded).
 * The declared shape is a record of strings, but models stringify a nested map, which strict
 * validation rejects at the cost of a zero-work round trip.
 */
export function payloadRecord(input: unknown): Record<string, string> | undefined {
  if (isRecord(input)) return asStringRecord(input);
  if (typeof input !== "string") return undefined;
  const parsed = parseJsonObject(input);
  return parsed ? asStringRecord(parsed) : undefined;
}

const recordDisplay = (record: Record<string, unknown>): { name?: string; description?: string } | undefined => {
  const display: { name?: string; description?: string } = {};
  if (typeof record.name === "string") display.name = record.name;
  if (typeof record.description === "string") display.description = record.description;
  return display.name !== undefined || display.description !== undefined ? display : undefined;
};

/**
 * The display label from the shape a model actually sends: the object, or the bare objective
 * string it cold-starts with. A cosmetic label keeps its intent over its shape.
 */
export function normalizeDisplay(input: unknown): { name?: string; description?: string } | undefined {
  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return undefined;
    const parsed = parseJsonObject(text);
    return (parsed && recordDisplay(parsed)) ?? { name: input };
  }
  if (isRecord(input)) return recordDisplay(input);
  return undefined;
}

/**
 * The fabric_exec envelope as the server should judge it: a bare string or a string[] program
 * becomes one code string, payloads may arrive as JSON text or under the legacy `strings` alias,
 * unknown optional keys are dropped, and display is normalized. Values that still do not fit are
 * left as they are, so the strict envelope names the field instead of this repair guessing.
 */
export function prepareArguments(input: unknown): unknown {
  if (typeof input === "string") return prepareArguments({ code: input });
  if (!isRecord(input)) return input;

  let prepared = input;
  const writable = (): Record<string, unknown> => {
    if (prepared === input) prepared = { ...input };
    return prepared;
  };

  if (Array.isArray(prepared.code) && prepared.code.every((line) => typeof line === "string")) {
    writable().code = prepared.code.join("\n");
  }

  for (const key of PI_ONLY_KEYS) if (Object.hasOwn(prepared, key)) delete writable()[key];

  for (const key of OPTIONAL_KEYS) {
    if (!Object.hasOwn(prepared, key)) continue;
    if (prepared[key] === null || prepared[key] === undefined) delete writable()[key];
  }

  const display = normalizeDisplay(prepared.display);
  if (display) {
    if (prepared.display !== display) writable().display = display;
  } else if (Object.hasOwn(prepared, "display")) {
    delete writable().display;
  }

  const hasPayloads = Object.hasOwn(prepared, "payloads");
  const hasStrings = Object.hasOwn(prepared, "strings");
  if (hasPayloads || hasStrings) {
    const raw = hasPayloads ? prepared.payloads : prepared.strings;
    const normalized = payloadRecord(raw);
    if (normalized) {
      if (prepared.payloads !== normalized) writable().payloads = normalized;
    } else if (!hasPayloads) {
      // A malformed alias moves to the canonical key, so the error names payloads.
      writable().payloads = raw;
    }
    if (hasStrings) delete writable().strings;
  }

  return prepared;
}
