// Reconstruct the failure and status checks from normalized source events.
import { clipUtf8, MAX_RENDERED_LINE_BYTES, omissionLine, sampleAddressedFrom, utf8Bytes } from "./bounds.ts";
import { firstLine, type CompactionEvent, type ToolCallEvent } from "./from-claude.ts";
import { ASSISTANT_CAVEAT } from "./render.ts";

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "Grep", "Glob"]);
const MAX_UNRESOLVED = 24;
const pathOf = (args: Record<string, unknown>): string | undefined => {
  const path = args.file_path ?? args.path ?? args.dir;
  return typeof path === "string" && path.trim() ? path : undefined;
};
const truncate = (text: string, max: number, verbatim = false): string => {
  const flat = verbatim ? text.trim() : text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
interface Operation { index: number; entryId: string; name: string; args: Record<string, unknown>; error: boolean; text: string; }

const operations = (events: readonly CompactionEvent[]): Operation[] => {
  const calls = new Map<string, ToolCallEvent>();
  for (const event of events) if (event.kind === "toolCall") calls.set(event.toolCallId, event);
  return events.flatMap((event) => {
    if (event.kind === "bash") return [{ index: event.index, entryId: event.entryId, name: "Bash", args: { command: event.command }, error: event.isError, text: event.error ?? "" }];
    if (event.kind !== "toolResult") return [];
    const call = calls.get(event.toolCallId);
    if (!call) return [];
    return [{ index: event.index, entryId: event.isError && event.text ? event.entryId : call.entryId,
      name: call.name, args: call.args, error: event.isError, text: event.isError ? event.text : "" }];
  });
};

const identity = (operation: Operation): string => {
  const path = FILE_TOOLS.has(operation.name) ? pathOf(operation.args) : undefined;
  if (path) return `file\0${operation.name}\0${path}`;
  if (operation.name === "Bash") return `bash\0Bash\0${String(operation.args.command ?? "")}`;
  return `generic\0${operation.name}\0${JSON.stringify(operation.args)}`;
};

export const sourceFailures = (events: readonly CompactionEvent[]): string[] => {
  const all = operations(events);
  const success = new Map<string, number>();
  for (const operation of all) if (!operation.error) success.set(identity(operation), operation.index);
  const failures = all.filter((operation) => operation.error).map((operation) => {
    const path = FILE_TOOLS.has(operation.name) ? pathOf(operation.args) : undefined;
    const subject = path ? `${operation.name} ${path}` : operation.name === "Bash"
      ? `Bash: ${truncate(firstLine(String(operation.args.command ?? "")), 140)}` : operation.name;
    const error = operation.text ? `: ${truncate(firstLine(operation.text), 140, true)}` : ": failed";
    return { ...operation, description: `${subject}${error}`, resolved: (success.get(identity(operation)) ?? -1) > operation.index };
  });
  const open = failures.filter((failure) => !failure.resolved);
  const older = open.slice(0, Math.max(0, open.length - MAX_UNRESOLVED));
  const shown = open.slice(-MAX_UNRESOLVED);
  const resolved = failures.filter((failure) => failure.resolved);
  const lines: string[] = [];
  if (older.length) lines.push(omissionLine(older.length, older[0]?.entryId, older.at(-1)?.entryId, "older open error records"));
  for (const failure of shown) lines.push(`- ${failure.description} [entry ${failure.entryId}]`);
  if (resolved.length) lines.push(omissionLine(resolved.length, resolved[0]?.entryId, resolved.at(-1)?.entryId, "error records later resolved by an exact retry"));
  return lines;
};

// Files and earlier-turn text are reconstructed only to locate subsequent
// sections. They are not additional QA probes.
export const sourceFiles = (events: readonly CompactionEvent[]): string[] => {
  type Address = { path: string; entryId: string };
  const read = new Map<string, Address>(), modified = new Map<string, Address>(), written = new Map<string, Address>();
  for (const operation of operations(events)) {
    if (operation.error || !FILE_TOOLS.has(operation.name)) continue;
    const path = pathOf(operation.args);
    if (!path) continue;
    const target = operation.name === "Write" ? written : operation.name === "Edit" ? modified : read;
    if (!target.has(path)) target.set(path, { path, entryId: operation.entryId });
  }
  const modifiedPaths = new Set([...modified.keys(), ...written.keys()]);
  const kinds = [
    ["Written:", sampleAddressedFrom(written.values(), 24)],
    ["Modified:", sampleAddressedFrom(modified.values(), 24)],
    ["Read:", sampleAddressedFrom([...read.values()].filter(({ path }) => !modifiedPaths.has(path)), 24)],
  ] as const;
  const addresses = kinds.flatMap(([, sampled]) => sampled.values);
  if (!addresses.length) return [];
  const segments = addresses.map(({ path }) => path.split(/[\\/]/).filter(Boolean));
  const common: string[] = [];
  for (let index = 0; index < segments[0]!.length; index++) {
    const part = segments[0]![index]!;
    if (!segments.every((value) => value[index] === part)) break;
    common.push(part);
  }
  const root = common.length ? `${common.join("/")}/` : "";
  const lines: string[] = root ? [`(under ${root})`] : [];
  for (const [header, sampled] of kinds) {
    if (!sampled.values.length && !sampled.omitted) continue;
    lines.push(header);
    sampled.values.forEach((item, index) => {
      if (sampled.omitted && index === sampled.splitIndex) lines.push(`  ${omissionLine(sampled.omitted, sampled.omittedFirstEntryId, sampled.omittedLastEntryId, "file addresses")}`);
      lines.push(`  ${root ? item.path.replace(root, "") : item.path} [entry ${item.entryId}]`);
    });
  }
  return lines;
};

export const sourceEarlierTurns = (events: readonly CompactionEvent[]): string[] => {
  const turns: { entryId: string; context: string; tools: string }[] = [];
  let user: Extract<CompactionEvent, { kind: "user" }> | undefined;
  let counts = new Map<string, number>();
  const completed = (): void => {
    if (!user) return;
    turns.push({ entryId: user.entryId, context: JSON.stringify(truncate(firstLine(user.text), 80)),
      tools: [...counts].map(([name, count]) => `${name}:${count}`).join(" ") });
  };
  for (const event of events) {
    if (event.kind === "user") {
      completed();
      user = event;
      counts = new Map();
      continue;
    }
    if (!user) continue;
    const name = event.kind === "toolCall" ? event.name : event.kind === "bash" ? "Bash" : undefined;
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const sampled = sampleAddressedFrom(turns, 32);
  const lines: string[] = [];
  sampled.values.forEach((turn, index) => {
    if (sampled.omitted && index === sampled.splitIndex) lines.push(omissionLine(sampled.omitted, sampled.omittedFirstEntryId, sampled.omittedLastEntryId, "earlier turns"));
    lines.push(`${turn.context}${turn.tools ? ` | ${turn.tools}` : ""} [entry ${turn.entryId}]`);
  });
  return lines;
};

const sample = (lines: readonly string[], keep: number): string[] => {
  if (lines.length <= keep) return [...lines];
  const first = Math.ceil(keep / 2), last = Math.floor(keep / 2);
  return [...lines.slice(0, first), `… omitted ${lines.length - keep} rendered lines`, ...lines.slice(lines.length - last)];
};

export const sourceHistoryBlock = (header: string, lines: readonly string[], grant: number): string => {
  const clipped = lines.map((line) => clipUtf8(line, MAX_RENDERED_LINE_BYTES));
  const capped = sample(clipped, Math.min(clipped.length, 128));
  for (let keep = capped.length; keep >= 0; keep--) {
    const result = [header, ...sample(capped, keep)].join("\n");
    if (utf8Bytes(result) <= grant) return result;
  }
  return clipUtf8(header, grant);
};

export const sourceStatus = (events: readonly CompactionEvent[], lastChange: string): { header: string; lines: string[] } => {
  const user = [...events].reverse().find((event) => event.kind === "user");
  const assistant = [...events].reverse().find((event) => event.kind === "assistantText");
  const lines: string[] = [];
  if (user?.kind === "user") lines.push(`Last request: ${truncate(firstLine(user.text), 140)} [entry ${user.entryId}]`);
  if (lastChange) lines.push(lastChange);
  if (assistant?.kind === "assistantText") {
    const note = truncate(firstLine(assistant.text), 140);
    if (note) lines.push(`Assistant note: ${note}`);
  }
  return { header: assistant?.kind === "assistantText" && truncate(firstLine(assistant.text), 140)
    ? `[Current Status]\n${ASSISTANT_CAVEAT}` : "[Current Status]", lines };
};
