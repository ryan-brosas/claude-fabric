// The deferred tool list Claude Code sends when code mode is off: one line per deferred tool, which
// for a session with many MCP servers is tens of thousands of characters on every request. Native
// code mode sends a short server list instead, and a fabric session is compared against it. So a
// fabric session gets the same shape: built-in tools by name, MCP tools as one line per server with
// its tool count. ToolSearch still finds every tool; only the list the model reads is shorter.

/** The first line of the section this rewrites, as Claude Code writes it. */
export const DEFERRED_HEADER = "The following deferred tools are now available via ToolSearch.";

const COMPACT_HEADER =
  'Deferred tools, schemas NOT loaded: call ToolSearch with a keyword, or with "select:<name>[,<name>...]", before calling one. ' +
  "A fabric_exec program calls an MCP tool with no ToolSearch: mcp.<server>.<tool>(args), - and . written _. " +
  "Built-ins by name, then MCP servers by prefix and tool count:";

const MCP_NAME = /^mcp__(.+?)__(.+)$/;

/**
 * The attachment text with its deferred tool section rewritten, or the text unchanged when it has
 * no such section or the section holds a line that is not a tool name. Every other section
 * (tools ready to use, servers that need sign-in or are still connecting) is kept as written.
 */
export function compactDeferred(text: string): string {
  const sections = text.split("\n\n");
  const at = sections.findIndex((section) => section.startsWith(DEFERRED_HEADER));
  if (at === -1) return text;
  const names = sections[at]!.split("\n").slice(1);
  if (names.length === 0 || names.some((name) => !/^[\w.-]+$/.test(name))) return text;

  const builtins: string[] = [];
  const servers = new Map<string, number>();
  for (const name of names) {
    const mcp = MCP_NAME.exec(name);
    if (mcp === null) builtins.push(name);
    else servers.set(mcp[1]!, (servers.get(mcp[1]!) ?? 0) + 1);
  }
  const lines = [COMPACT_HEADER, ...builtins];
  for (const [server, count] of servers) lines.push(`mcp__${server}__* (${count} tool${count === 1 ? "" : "s"})`);
  const rewritten = lines.join("\n");
  return rewritten.length < sections[at]!.length
    ? [...sections.slice(0, at), rewritten, ...sections.slice(at + 1)].join("\n\n")
    : text;
}
