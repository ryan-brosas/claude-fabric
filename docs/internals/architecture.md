# Architecture

How claude-fabric carries pi-fabric's runtime into Claude Code, and where each part lives.
Rewrite this page when the shape changes.

## Two ways into Claude Code

pi-fabric is one Pi extension: it loads inside the Pi process and hooks everything through
`pi.on(...)`. Claude Code has two surfaces that together cover the same ground:

- **A mod** (`hooks/hooks.json` `modules`): TypeScript handlers that run inside Claude Code's
  hooks worker. This is the counterpart of a Pi extension: it can answer compaction, rewrite system
  prompt sections, guard and rewrite tool calls and stored tool results, spawn subagents, register
  commands and draw UI. Docs: code.claude.com/docs/en/plugins/mods/overview.
- **An MCP server** (`mcpServers` in `plugin.json`): a Bun process that serves `fabric_exec` and
  does the heavy work: the type checker, the per-call Worker, providers and storage.

The mod is thin and the server is heavy, because of the mod's limits: a hook gets 10 s of its own
time, a hooks module imports only files inside the plugin plus `claude-code` (no npm, no
dynamic `import()`), and three crashes of the hooks worker unload every installed mod for the
session.

## Proven on this machine

Probed 2026-11-18 on Claude Code 2.1.327 with a throwaway mod loaded through `--plugin-dir`:

- The mod loads, and `prompt.section` fires for each system prompt section, so the built-in
  guard that blocks user mods from those events is not loaded here. (It loads on Team or
  Enterprise `/login` sessions and on machines with managed settings.)
- `session.compact` fires on `/compact` with `{ trigger, messages }`. A hook that returns
  `{ messages: [summary, ...tail] }` replaces Claude Code's compactor: compaction ran with no model
  call, and the model then answered from a fact that only our summary held.

The rest of the table below comes from the generated mod types
(`.claude-plugin/types/claude-code/index.d.ts`, written by Claude Code for its own version) and
the docs. It is untested until a row says otherwise.

## pi-fabric part by part

| pi-fabric part | Pi surface it uses | Claude Code surface | Status |
| --- | --- | --- | --- |
| `fabric_exec` | `registerTool` | MCP server tool | built |
| Compaction (`src/compaction`) | `session_before_compact` | `session.compact` returns `{ messages }` | proven |
| Compaction thresholds, headroom, `compact.request` | `agent_settled`, `ctx.compact()` | `session.measure`, `$.session.usage()`, `$.session.compact()` between turns, `precompute` trigger | documented |
| Prompt guidance (`core/prompt-guidance`, `core-override-guidance`) | `before_agent_start` | `prompt.section`, `prompt.compose` | fires (proven); rewrite documented |
| Tool middleware (`tool_call`, `tool_result`, bash errors, capture) | `tool_call`, `tool_result` | `tool.call` (rewrite, deny, answer), `session.append` door `tool-result` | documented |
| Tool ownership and full code mode | `context_with_system` | `tool.describe` (`isDeferred`), `tool.call` deny, `agent.offer` | documented; hiding built-ins unverified |
| Top-level tools inside programs (WebSearch, Agent) | `pi.*` providers | `$.tool.call` from the mod, bridged to the server | documented; needs a probe |
| Input transforms (pasted images) | `input` | `prompt.submit` | documented |
| Agents and actors | Pi child processes | `$.agent.spawn/call/list`, `agent.spawn` hook | documented |
| Mesh, sessions, decisions | own transport | `$.session.send`, `session.receive` | documented |
| Thinking control | `thinking.*` | `turn.step` `effort` | documented |
| Commands (`/fabric`, settings) | `registerCommand` | `$.command.register`, `command.run` | documented |
| UI (`src/ui`, 29k lines of Pi TUI) | Pi TUI | `ui.render`: panes, band, tool-call rows, spinner | rebuild, not port |
| Memory, state, programs, schema, store | none (own storage) | server storage under `CLAUDE_PLUGIN_DATA` | no host dependency |
| QuickJS, Node-process, Python runtimes | none | server | no host dependency |
| Per-request context projection (extractive history, prewalk continuation) | `context` | none: `turn.step` messages are pinned | gap; nearest is a compaction between turns |
| Model providers, Jev auth, model pin guard | `registerProvider`, `before_provider_request` | `turn.step` and `agent.spawn` pick a model only | gap: no custom providers |
| Cache warming leases | `cache_warming_decision` | none | gap |
| Session tree, fork, switch | `session_tree` and others | `session.end` reasons only | gap; mostly Pi-specific |

## Layout

```text
.claude-plugin/plugin.json   manifest: the MCP server, userConfig
hooks/hooks.json             modules: the mod entry in src/mod/
src/
  mod/          binding 1, in-process: compaction, prompt sections, tool middleware, commands, UI
  server/       binding 2, MCP: fabric_exec and the mod's heavy calls
  kernel/       check -> stages -> execute -> bound; bridge; executors/
  registry/     defineAction({ ns, name, input, doc, run }); generates guest types and DESCRIPTION
  providers/    one folder per namespace: tools/ (Read..Bash), then store, mcp, agents, ...
  stages/       pure self-correcting stages: args, code repair, type guidance, repeat guard, budget
  compaction/   the deterministic compactor, pure
test/           mirrors src/
```

## Rules

1. **One definition per action.** An action is defined once in `providers/`. Guest types, the
   model-facing description and runtime argument checks are generated from it.
2. **Imports point one way:** `server -> kernel -> registry <- providers`, and
   `mod -> compaction, stages`. Only `server/` knows MCP; only `mod/` knows the mods API.
3. **What the mod imports is pure.** No bare imports and no `node:` modules, because the hooks
   worker refuses them. A test reads the import graph from `src/mod/` and fails on any.
4. **The mod never blocks on heavy work.** Anything slow goes to the server, so a hook stays
   under its 10 s budget and a fault there can't crash the hooks worker.
5. **Every effect crosses one bridge.** A program's tool calls cross `kernel/bridge` as
   `{ ref, args }`, so a sandbox executor can replace the Worker without touching providers.
6. **Copied pi-fabric code keeps its MIT credit** in a header line.

## Open probes

- How the mod reaches the server privately: `$.mcp.call` on our own server, `$.process.run`, or
  a local socket. A server tool the mod calls must not show up as a tool the model can call.
- Whether `$.tool.call` from the mod reaches built-in tools (WebSearch, Agent) for programs.
- Whether a mod can take built-in tools off the model's list, which full code mode needs.
- `session.append` door `compaction` did not fire for core's own compaction in the probe.
