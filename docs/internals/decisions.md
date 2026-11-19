# Decisions

What shapes claude-fabric, and why. Rewrite an entry when it changes; don't add a second one.

## Shape

- **A port of pi-fabric's whole runtime to Claude Code** (the user's call, 2026-11-18). It is
  not a fork: each part is rebuilt on the Claude Code surface that fits it, copying Pi-free modules
  with MIT credit. [architecture.md](architecture.md) maps every part to its surface and marks
  what is proven, documented or a gap.
- **A mod plus an MCP server.** The mod runs inside Claude Code and handles compaction, prompt
  sections, tool middleware, commands and UI. The MCP server serves `fabric_exec` and does the
  heavy work. The mod stays thin because of its 10 s hook budget and import limits.
- **Fabric's compactor replaces Claude Code's.** A `session.compact` hook that returns
  `{ messages }` answers in core's place, with no model call (proven 2026-11-18). `precompute`
  answers `{ skip }`: the summary is deterministic, so there is nothing to compute ahead of time.
- **A summary names itself, and a later compaction carries it.** The rendered summary opens
  with `[Fabric summary]`, so the next compaction recognizes its own earlier summary by that
  header instead of reading it as a user prompt. Pi re-derives a second summary from the raw
  branch, which a Claude transcript no longer holds; here the earlier summary is kept as the
  `[Earlier summary]` block, because a 2,048-byte prose excerpt would lose its sections. It is
  allocated inside the same 32 KiB as every other block (proved `summaryCarry`): the newest
  directions, the compaction request and the footer keep their bytes, the room left is split
  evenly between the carry and the operational history, and a carry that does not fit keeps its
  newest bytes with the loss stated on its first line.
- **Claude Code names, no Pi vocabulary** (the user's call, 2026-11-18). Kept from Fabric: the
  one-string shorthand, and `Bash` rejecting on a nonzero exit (`allowFailure: true` opts out).
- **`fabric_exec` stays an MCP tool.** Claude passes `CLAUDE_PROJECT_DIR` and
  `CLAUDE_CODE_SESSION_ID` to the server. A mod can also register tools, but the type checker and
  Worker can't run inside the hooks worker.
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
- `mcp.<server>.<tool>()` inside programs. First choice: route it through the mod's
  `$.mcp.call`, which uses Claude Code's own connections and credentials, claude.ai connectors
  included. Fallback if that bridge fails its probe: the official MCP SDK reading Claude's MCP
  config, for stdio servers and HTTP servers with header keys only.
- A benchmark of plain Claude, Claude with native code mode, and Claude with `fabric_exec`.
  Pass: it solves at least as many tasks as native code mode, with at most 10% more tokens.
- After the benchmark, native code mode is turned off. Every other tool stays visible.

## Out of scope

What Claude Code gives a plugin no surface for: custom model providers and Jev auth, cache
warming leases, per-request context projection (Pi's `context` event), and Pi's session tree.
Pi's TUI is not ported; UI is rebuilt on mod elements. Revisit a gap when Claude Code adds the
surface.
