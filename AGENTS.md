# claude-fabric

A Claude Code plugin that brings [pi-fabric](https://github.com/fabric-runtime/pi-fabric)'s
`fabric_exec` to Claude Code. The goal is for Claude to use it instead of Claude Code's native
code mode. It has to earn that in the benchmark (step 4 below); until then, that it saves tokens
is a hypothesis.

## What we're building

- **One tool, `fabric_exec`.** Claude sends one TypeScript program. The program reads, searches,
  edits and runs commands through `Read`, `Write`, `Edit`, `Grep`, `Glob` and `Bash`, with the
  same names and fields as Claude Code's own tools. Independent calls run in parallel with
  `Promise.all`. Only what the program returns or prints comes back, cut to a fixed size, so file
  contents and command output it only passes through never enter Claude's context.
- **Checked before it runs.** Every program is type-checked first. A type error comes back with
  line numbers, and no tool call has happened.
- **Shipped as a plugin.** A Claude Code plugin can add a tool only through an MCP server, so
  the plugin starts one MCP server (`server/`) with one tool. The tool shows up as
  `mcp__plugin_fabric_fabric__fabric_exec`.
- **Only `fabric_exec` from pi-fabric.** pi-fabric is a whole runtime for the Pi agent (agents,
  actors, mesh, workflows, memory). We take `fabric_exec` and the modules that make it correct
  itself, and nothing else. Pi names (`pi.read`, `pi.bash`) never appear.

Where it stands:

1. **Done:** the kernel (check, fresh Bun Worker per call, bounded result), the MCP server and
   plugin, and Claude Code tool names inside programs.
2. **Next:** port pi-fabric's self-correcting modules: argument repair, code repair, output
   budget, type-error guidance and a repeat guard. Copy them with MIT credit.
3. **Then:** `store`/`load` between calls, `__bun` with logged writes and spawns, and
   `mcp.<server>.<tool>()` inside programs.
4. **Benchmark:** plain Claude, Claude with native code mode, and Claude with `fabric_exec`, on
   the same tasks. It passes when `fabric_exec` solves at least as many tasks as native code mode
   with at most 10% more tokens.
5. **Last:** turn native code mode off and run the benchmark again.

Each step's details and the things we chose not to build are in
[docs/internals/decisions.md](docs/internals/decisions.md).

The user's global `AGENTS.md` supplies standing rules. This file adds project context, not
exceptions. If a rule here fights the task, say so loudly.

Words: [CONTEXT.md](CONTEXT.md) is the glossary. Use its terms in code, tests and PR text.
Read [docs/internals/decisions.md](docs/internals/decisions.md) before you add scope.

## What we never compromise on

1. **Claude Code's vocabulary, not Pi's.** Program tools are `Read`, `Write`, `Edit`, `Grep`,
   `Glob` and `Bash`, with Claude Code's field names. Model-facing text never says `pi.`.
   Enforced by `test/server.test.ts` ("lists exactly one tool").
2. **Nothing runs until it type-checks.** A type error returns line numbers, and no tool call
   happens. Enforced by the "type error is reported and nothing runs" test and the spike.
3. **One bounded result.** Only the return value and `print()` lines reach the model, and
   they are cut at a fixed size (`kernel/host.ts`).

## The ways to hurt yourself

1. **Writing to the MCP server's stdout.** stdout is the MCP stream. A `console.log` in the
   server, or install output, corrupts it. `server/start.sh` sends `bun install` to stderr for
   this reason.
2. **Running programs against this repo in tests.** Programs run in `CLAUDE_PROJECT_DIR`. The
   tests point that at a temporary dir. Keep it that way, so write tests never touch the checkout.
3. **Editing or checking `upstream/`.** It is a gitignored reference clone of pi-fabric.
   `bunfig.toml` and `tsconfig.json` keep it out of the tests and the typecheck. Copy from it
   with MIT credit; don't change it.
4. **Naming the plugin `claude-*`.** Claude Code reserves that prefix. The plugin is `fabric`
   and the marketplace is `fabric-exec`.
5. **Trusting a `claude -p` run to cover native code mode.** Native code mode runs only in an
   interactive terminal. Drive comparisons in tmux.

## Hit every surface

The common miss is a program tool that changes in one place only. When you add or change a
tool or a field, update all of these:

- **`kernel/tools.ts`**: the host implementation.
- **`kernel/guest.d.ts`**: the types the checker gives programs.
- **`kernel/worker.ts`**: `TOOL_NAMES`, the globals the worker passes in.
- **`server/index.ts`**: `DESCRIPTION`, which is what the model reads.
- **`test/server.test.ts`**: one test through the real MCP server.

## Check

```sh
bun run typecheck && bun run spike && bun run test
```

CI runs the same three on Bun 1.4.0 with ripgrep. `spike` runs sample programs against this
repo and prints timings. `test` starts the real MCP server over stdio and calls `fabric_exec`.
Green doesn't prove the plugin loads in Claude Code. For that, run
`claude --plugin-dir .` and call the tool, which shows up as
`mcp__plugin_fabric_fabric__fabric_exec`.

## How it works

`server/index.ts` gets a call. `kernel/check.ts` wraps the code as an async function body and
type-checks it against `guest.d.ts` with a warm TypeScript program. `kernel/host.ts` then starts
a fresh Bun Worker. Each tool call in the program goes to the host as a message, and the host
runs it from `kernel/tools.ts`. On a timeout or when the call ends, the host terminates the
Worker.

## Docs and scratch

Most changes need no doc change. Rewrite a page instead of adding to it. Plans, inventories and
benchmarks in progress go in `notes/`, which is gitignored.
