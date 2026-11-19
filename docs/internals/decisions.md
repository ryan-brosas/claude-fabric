# Decisions

What shapes claude-fabric, and why. Rewrite an entry when it changes; don't add a second one.

## Shape

- **A new lean codebase that follows Fabric's design.** It is not a fork. Copy only the Pi-free
  modules that make `fabric_exec` correct itself (argument prepare, code repair, output budget,
  type-error guidance, type checker), with MIT credit to pi-fabric.
- **Claude Code names, no Pi vocabulary** (the user's call, 2026-11-18). Kept from Fabric: the
  one-string shorthand, and `Bash` rejecting on a nonzero exit (`allowFailure: true` opts out).
- **An MCP server is the only way in.** A plugin can add a tool the model sees only through an
  MCP server. Claude passes `CLAUDE_PROJECT_DIR` and `CLAUDE_CODE_SESSION_ID` to it, so no hook
  is needed.
- **A fresh Bun Worker per call.** It costs about 1.3 ms, against 14 ms for `Bun.spawn`. Node's
  `vm` is faster but gives no thread to terminate. `terminate()` handles timeouts.
- **A warm type checker in the server, run before every call.**

## Trust

- **The worker is not a security sandbox.** Programs run in an ordinary Bun Worker. The type
  checker hides Bun's globals, but `globalThis as any` still reaches `Bun`, `fetch` and
  `process`, so a program isn't limited to the program tools. So they run only at the
  trust given to `fabric_exec`. pi-fabric's default is different: a QuickJS sandbox with no
  filesystem, network or process, where every effect goes through the host. pi-fabric itself
  calls its Node-process mode "not a security boundary". Open: whether to move to a sandbox
  before the repo goes fully public.
- **No approval layer.** Programs run at the trust given to `fabric_exec`; the target is auto
  mode. Other permission modes come later.
- **No background shell tasks.** `Bash` waits. Long jobs use Claude's own Bash in the background.

## Planned, not built

- `store`/`load` to keep data between calls.
- `__bun`: Bun inside programs, with writes, spawns and deletes logged to a journal.
- `mcp.<server>.<tool>()` inside programs, through the official MCP SDK reading Claude's MCP
  config. It covers stdio servers and HTTP servers with header keys. OAuth servers and claude.ai
  connectors stay top-level.
- A benchmark of plain Claude, Claude with native code mode, and Claude with `fabric_exec`.
  Pass: it solves at least as many tasks as native code mode, with at most 10% more tokens.
- After the benchmark, native code mode is turned off. Every other tool stays visible.

## Out of scope

Agents, actors, mesh, state, schema, components, memory, Python, Fabric's MCP client
(mcporter), extension capture, Fabric compaction, cache warming and a TUI.
