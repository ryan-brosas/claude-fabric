// Adapted from pi-fabric (MIT, Tom X Nguyen) packages/pi-recall/src/memory/normalize.ts at d331f629;
// Claude Code's JSONL rows and compact boundaries replace Pi's message records.
export type EntryKind = "user" | "assistant" | "summary" | "tool_result" | "tool";
export interface Entry { uuid: string; parent: string | null; kind: EntryKind; text: string; timestamp: string | null }
export interface Boundary { uuid: string; uuids: string[]; allUuids: string[]; unresolvable: string[] }
export interface Transcript { entries: Entry[]; byId: Map<string, Entry>; boundaries: Boundary[] }
export type TranscriptRow = Record<string, unknown>;
type Row = TranscriptRow;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const textParts = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    const block = object(part);
    return block.type === "text" ? string(block.text) : "";
  }).filter(Boolean).join("\n");
};

/** Text held by one Claude transcript row, including tool inputs and tool-result bodies. */
export function entryText(row: Row): { text: string; kind: EntryKind } {
  const message = object(row.message);
  const content = message.content;
  const parts: string[] = [];
  let toolUse = false, toolResult = false;
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const value of content) {
      const block = object(value);
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      else if (block.type === "tool_use") {
        toolUse = true;
        parts.push(`Tool: ${string(block.name)}(${JSON.stringify(block.input ?? {})})`);
      } else if (block.type === "tool_result") {
        toolResult = true;
        const body = textParts(block.content);
        parts.push(`toolResult${block.is_error === true ? " [error]" : ""}${body ? `: ${body}` : ""}`);
      }
    }
  }
  const kind: EntryKind = row.isCompactSummary === true ? "summary" : toolResult ? "tool_result"
    : toolUse ? "tool" : row.type === "assistant" ? "assistant" : "user";
  return { text: parts.join("\n"), kind };
}

/** Physical file order need not be chain order. Follow the last conversation row by UUID. */
export function transcriptChain(text: string): { chain: TranscriptRow[]; rows: Map<string, TranscriptRow> } {
  const rows = new Map<string, Row>();
  let leaf = "";
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let row: Row;
    try { row = object(JSON.parse(line)); }
    catch { throw new Error(`history: invalid transcript JSON at line ${index + 1}`); }
    const uuid = string(row.uuid);
    if (!uuid || row.isSidechain === true) continue;
    if (rows.has(uuid)) throw new Error(`history: duplicate transcript uuid ${uuid}`);
    rows.set(uuid, row);
    if (row.type === "user" || row.type === "assistant") leaf = uuid;
  }
  const chain: Row[] = [];
  const visited = new Set<string>();
  while (leaf) {
    if (visited.has(leaf)) throw new Error(`history: transcript parent cycle at ${leaf}`);
    const row = rows.get(leaf);
    if (!row) throw new Error(`history: transcript parent uuid ${leaf} is missing`);
    visited.add(leaf);
    chain.push(row);
    const parent = row.parentUuid ?? row.logicalParentUuid;
    if (parent != null && typeof parent !== "string") throw new Error(`history: transcript parent of ${leaf} is invalid`);
    leaf = parent ?? "";
  }
  chain.reverse();
  return { chain, rows };
}

const conversationEntry = (row: Row): Entry | null => {
  if (row.type !== "user" && row.type !== "assistant") return null;
  return { uuid: string(row.uuid), parent: string(row.parentUuid ?? row.logicalParentUuid) || null,
    ...entryText(row), timestamp: string(row.timestamp) || null };
};

export function parseTranscript(text: string): Transcript {
  const { chain, rows } = transcriptChain(text);
  const byId = new Map<string, Entry>();
  for (const [uuid, row] of rows) {
    const entry = conversationEntry(row);
    if (entry) byId.set(uuid, entry);
  }
  const entries: Entry[] = [];
  const boundaries: Boundary[] = [];
  for (const row of chain) {
    const uuid = string(row.uuid);
    if (row.type === "system" && row.subtype === "compact_boundary") {
      const meta = object(row.compactMetadata);
      const preserved = object(meta.preservedMessages);
      const uuids = strings(meta.uuids ?? preserved.uuids);
      const allUuids = strings(meta.allUuids ?? preserved.allUuids);
      boundaries.push({ uuid, uuids, allUuids, unresolvable: allUuids.filter((id) => !rows.has(id)) });
    }
    const entry = byId.get(uuid);
    if (entry) entries.push(entry);
  }
  return { entries, byId, boundaries };
}
