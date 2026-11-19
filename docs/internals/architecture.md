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
  call, and the model then answered from a fact that only our summary held. Since step 3 the
  plugin's own mod does this: three `/compact`s in an interactive session logged "core never ran",
  and the model recalled facts planted before both cuts.
- Probed 2026-11-19 with a scratch plugin (an MCP server and a mod) under `claude -p --plugin-dir`:
  - A `tool.list` hook takes tools off the model's list, built-ins (WebFetch, Write) and MCP
    tools alike. A tool taken off that list is gone for the mod too: `$.mcp.call` answers "no
    connected MCP tool" and `$.tool.call` "no tool named ...". So a private server tool cannot
    hide that way, and programs keep their own server-side providers for tools the model loses.
  - `$.tool.call({ tool: "Read", ... })` from the mod runs the built-in and returns its record.
  - `$.mcp.call("context7", "resolve-library-id", ...)` reaches another connected server through
    Claude Code's own connection.
  - The mod reaches the server over a Unix socket: the server listens with
    `Bun.serve({ unix })`, and a loop the mod starts at `session.start` long-polls it with
    `$.http.fetch(url, { socketPath })`, runs the job (`$.tool.call` here) and posts the answer.
    A server tool waited 15 ms for a built-in Read this way. The loop runs outside the 10 s hook
    budget. Before the server listens and after it exits, the fetch is ECONNREFUSED, so the
    loop retries.
  - `await $.tool.call({ tool: "WebSearch", query: "..." })` from the mod answers `{ result, text }`:
    `result` is `{ query, results: [{ tool_use_id, content: [{ title, url, snippet? }] } | string],
    durationSeconds, searchCount? }`, and `text` is the plain string the model would see. `mode`
    may be left out.
  - Built on those probes: the bridge is the plugin's own. The server listens on
    `<CLAUDE_PLUGIN_DATA>/bridge/<session id>.sock`, writes a per-session secret beside it (0600)
    that every request must carry, and fails an mcp call at once when no mod is polling. The mod's
    loop reads the secret with `$.fs`, long-polls `/next`, runs the job with `$.mcp.call` or
    `$.tool.call` and posts `/answer`. The catalog of connected MCP servers rides the same socket,
    sent by the mod's `tool.list` hook, which the engine raises again when the tool pool changes.

The rest of the table below comes from the generated mod types
(`.claude-plugin/types/claude-code/index.d.ts`, written by Claude Code for its own version) and
the docs. It is untested until a row says otherwise.

## How an mcp call travels

A program's `mcp.<server>.<tool>(args)` crosses the worker bridge like any program tool, carrying
the two keys the program wrote. The host resolves them against the session's catalog
(`src/registry/mcp.ts`) and asks the access machine (`proofs/mcp-access.ts`): only a pair the
catalog holds, and never this plugin's own server, sends a job. The job goes over the socket; the
mod runs it with `$.mcp.call` on Claude Code's own connection and posts the raw result back; the
host turns it into the call's value. The server starts no MCP client of its own.

## How a WebSearch travels

A program's `WebSearch({ query, ... })` is an ordinary program tool in `src/providers/tools/`, so
the registry prints its types, its tool line and its argument check from the one definition. Its
`run` does not run in the server: the host asks the access machine
([proofs/builtin-access.ts](../../proofs/builtin-access.ts)) and, only for a tool the fixed
allowlist holds (`BUILTIN_TOOLS` in `src/bridge/contract.ts`, whose one entry is `WebSearch`),
sends a built-in tool job down the mcp call's own queue and answer path. The mod answers it with
one literal `$.tool.call({ tool: job.tool, ...job.input })` and posts back `{ result, text }`;
the program's value is `{ text, results }`, the hits flattened out of `result.results`, and
`mode` defaults to `"standard"`. The mod checks the same allowlist again before it calls
anything, so a host bug is not a second way to a built-in tool. `Agent` and every other built-in
stay top-level only: `$.tool.call` skips the person's permission prompts and deny rules, so the
list is the user's decision ([decisions.md](decisions.md)).

## pi-fabric part by part

| pi-fabric part | Pi surface it uses | Claude Code surface | Status |
| --- | --- | --- | --- |
| `fabric_exec` | `registerTool` | MCP server tool | built |
| Compaction (`src/compaction`) | `session_before_compact` | `session.compact` returns `{ messages }` | built |
| Compaction thresholds, headroom, `compact.request` | `agent_settled`, `ctx.compact()` | `session.measure`, `$.session.usage()`, `$.session.compact()` between turns, `precompute` trigger | documented |
| Prompt guidance (`core/prompt-guidance`, `core-override-guidance`) | `before_agent_start` | `prompt.compose`: one `fabric:guidance` section appended last, only when the pool holds `fabric_exec` | hook built and fake-event tested; live proof pending |
| Tool middleware (`tool_call`, `tool_result`, bash errors, capture) | `tool_call`, `tool_result` | `tool.call` (rewrite, deny, answer), `session.append` door `tool-result` | documented |
| Tool ownership and full code mode | `context_with_system` | `tool.describe` (`isDeferred`), `tool.call` deny, `agent.offer` | hiding built-ins proven (`tool.list`); the hidden tool is gone for the mod too |
| Top-level tools inside programs (WebSearch, Agent) | `pi.*` providers | `$.tool.call` from the mod, over the socket bridge | WebSearch built behind the allowlist, over the jobs an mcp call uses; Read and WebSearch proven; Agent stays out |
| `mcp.<server>.<tool>()` (the MCP provider) | provider descriptors, the guest `mcp` proxy | `$.mcp.call` from the mod, over the bridge; the catalog from the `tool.list` hook | built |
| Input transforms (pasted images) | `input` | `prompt.submit` can rewrite text; its attachment list is pinned, so adding image blocks is not covered | gap for images; text documented |
| Agents and actors | Pi child processes | `$.agent.spawn/call/list`, `agent.spawn` hook | documented |
| Mesh (durable topics, compare-and-swap state), decisions (durable approvals), sessions (interactive processes) | own implementations | stay in the server; `$.session.send` and `session.receive` only deliver peer text | server-side; delivery documented |
| Thinking control (`thinking.*`) | `getThinkingLevel`, `setThinkingLevel`, `appendEntry`, turn-scoped reversion | `turn.step` `effort`: one step per rewrite, no `off` or `minimal` level | partial: needs a scoped controller in the mod and a level mapping |
| Commands (`/fabric`, settings) | `registerCommand` | `$.command.register`, `command.run` | documented |
| UI (`src/ui`, 29k lines of Pi TUI) | Pi TUI | `ui.render`: panes, band, tool-call rows, spinner | rebuild, not port |
| State, programs, schema, store | none (own storage) | the store lives in the server's memory; the rest is server storage under `CLAUDE_PLUGIN_DATA` | `store`/`load` built, as worker globals committed only on success; state, programs and schema not started |
| Memory (`src/memory`) | `sessionManager` session file, branch and leaf | index and storage in the server; history from a Claude transcript adapter (`transcript_path`, `$.session.messages()`) | needs the adapter |
| QuickJS, Node-process, Python runtimes | none | server | no host dependency |
| Per-request context projection (extractive history, prewalk continuation) | `context` | none: `turn.step` messages are pinned | gap; nearest is a compaction between turns |
| Model providers, Jev auth, model pin guard | `registerProvider`, `before_provider_request` | `turn.step` and `agent.spawn` pick a model only | gap: no custom providers |
| Cache warming leases | `cache_warming_decision` | none | gap |
| Session tree, fork, switch | `session_tree` and others | `session.end` reasons only | gap; mostly Pi-specific |

Prompt guidance rides `prompt.compose`, not `prompt.section`: compose carries the
session's tool pool (`e.tools`), so the section is added only when the pool holds
`mcp__plugin_fabric_fabric__fabric_exec`, and its result is the whole ordered list, so a
recompose is deduped by section id. `prompt.section` rewrites one named section and carries no
pool. Upstream's second guidance module, `core-override-guidance`, needs captured core overrides,
which Claude Code has no surface for.

## Layout

```text
.claude-plugin/plugin.json   manifest: the MCP server, userConfig
hooks/hooks.json             modules: the mod entry in src/mod/
src/
  mod/          binding 1, in-process: compaction, the mcp catalog and socket loop, prompt
                sections, tool middleware, commands, UI; index.ts holds every $ call and the
                socket loop, bridge.ts the pure helpers the hook bodies call
  guidance/     the one system prompt section's text, pure: tool names from
                providers/tools/names.ts, appended by the mod at prompt.compose
  server/       binding 2, MCP: fabric_exec and the mod's heavy calls
  kernel/       check -> stages -> execute -> bound; mcp.ts dispatches a program's mcp call,
                builtin.ts a program's built-in tool call; bridge/ is the server's half of the
                socket; executors/
  bridge/       the socket contract both halves read: paths, the secret header, catalog, both job
                kinds, answer, the mcp tool-name spelling and the built-in allowlist
  registry/     defineAction({ name, doc, input, output, positional, run }), and defineBuiltin
                for a guest global that is not a tool; generates guest types, the DESCRIPTION lines
                and the argument check. mcp.ts prints the mcp surface from the session's catalog
                and resolves a call against it
  providers/    one folder per namespace: tools/ (Read..Bash, WebSearch), store (the store/load
                globals), then agents, ...
  stages/       pure stages: args, code repair, type guidance, repeat guard, budget, the store's
                limits and commit
  compaction/   the deterministic compactor, pure
test/           mirrors src/
```

## Rules

1. **One definition per action.** An action is defined once in `providers/`, and `TOOLS` in
   `providers/tools/index.ts` is the one list. A guest global that is not a tool (`store`, `load`)
   is a `defineBuiltin` in `providers/store/`, listed in its `STORE`. `registry/generate.ts` prints
   the guest types the checker serves, the lines of `DESCRIPTION` and the runtime argument check
   from them, so a changed field changes one provider file.
2. **Imports point one way:** `server -> kernel -> registry <- providers`, and
   `mod -> compaction, stages, guidance`. Both halves of the socket also read `bridge/`, which
   imports nothing. Only `server/` knows MCP; only `mod/` knows the mods API.
   `providers/tools/names.ts` holds the program tools' names alone: `TOOLS` and every provider
   import zod, which the hooks worker refuses, so guidance reaches the names without it, and
   `test/guidance/guidance.test.ts` fails if the two lists drift.
3. **What the mod imports is pure.** No bare imports and no `node:` modules, because the hooks
   worker refuses them. A test reads the import graph from `src/mod/` and fails on any.
4. **A `$` call sits in its hook body.** The hooks compiler refuses a `$` bound, passed, spread,
   returned or read: it is only ever spelled `$.noun.method(...)` at the call site. So `src/mod/index.ts`
   holds every `$` call, the loop included, and `src/mod/bridge.ts` takes and returns plain data. The
   same test walks `src/mod/` and fails on a `$` used as a value, naming the rule and the fix.
5. **The mod never blocks on heavy work.** Anything slow goes to the server, so a hook stays
   under its 10 s budget and a fault there can't crash the hooks worker.
6. **Every effect crosses one bridge.** A program's tool calls cross `kernel/bridge` as
   `{ ref, args }`, so a sandbox executor can replace the Worker without touching providers.
7. **Copied pi-fabric code keeps its MIT credit** in a header line.

## Open probes

- Whether `$.tool.call` runs Agent for a program (Read and WebSearch do).
- Whether `session.append` door `compaction` fires for core's own compaction (it did not in the
  first probe).

