# claude-fabric

A Claude Code plugin that ports [pi-fabric](https://github.com/fabric-runtime/pi-fabric)'s
runtime to Claude Code, starting with `fabric_exec` and its compactor. The goal is for Claude to
use `fabric_exec` instead of Claude Code's native code mode. It has to earn that in the benchmark
(step 6 below); until then, that it saves tokens is a hypothesis.

## What we're building

- **One tool, `fabric_exec`.** Claude sends one TypeScript program. The program reads, searches,
  edits and runs commands through `Read`, `Write`, `Edit`, `Grep`, `Glob` and `Bash`, with the
  same names and fields as Claude Code's own tools. Independent calls run in parallel with
  `Promise.all`. Only what the program returns or prints comes back, cut to a fixed size, so file
  contents and command output it only passes through never enter Claude's context.
- **Checked before it runs.** Every program is type-checked first. A type error comes back with
  line numbers, and no tool call has happened.
- **Shipped as a plugin with two parts.** An MCP server serves `fabric_exec` (it shows up as
  `mcp__plugin_fabric_fabric__fabric_exec`) and does the heavy work. A mod runs inside Claude
  Code for what Pi did with `pi.on(...)`: compaction, prompt sections, tool middleware, commands
  and UI. [docs/internals/architecture.md](docs/internals/architecture.md) maps every pi-fabric
  part to its Claude Code surface.
- **All of pi-fabric that Claude Code has a surface for.** Pi names (`pi.read`, `pi.bash`)
  never appear.

Where it stands:

1. **Done:** the kernel (check, fresh Bun Worker per call, bounded result), the MCP server and
   plugin, and Claude Code tool names inside programs.
2. **Next:** move to the `src/` layout in architecture.md, with the action registry and an
   empty mod that loads.
3. **Then compaction:** port the deterministic compactor into `src/compaction/` and answer
   `session.compact` with it.
4. **Then** the self-correcting stages (argument repair, code repair, output budget, type-error
   guidance, repeat guard), copied with MIT credit.
5. **Then the rest of the map:** `store`/`load`, `__bun`, `mcp.<server>.<tool>()`, prompt
   guidance, tool middleware, agents and mesh, in the order architecture.md's probes allow.
6. **Benchmark:** plain Claude, Claude with native code mode, and Claude with `fabric_exec`, on
   the same tasks. It passes when `fabric_exec` solves at least as many tasks as native code mode
   with at most 10% more tokens.
7. **Last:** turn native code mode off and run the benchmark again.

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
   they are cut at a fixed size (`kernel/result.ts`).

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

`kernel/protocol.ts` holds the one list of program tools, `TOOL_NAMES`. The worker reads it,
and `kernel/tools.ts` must implement every name or the typecheck fails. Two places are still
written by hand, and a test fails if they drift from that list:

- **`kernel/guest.d.ts`**: the types the checker gives programs (`test/kernel.test.ts`).
- **`server/index.ts`**: `DESCRIPTION`, which is what the model reads (`test/server.test.ts`).

A changed field is not caught by any check: change it in `kernel/tools.ts`, `guest.d.ts` and
`DESCRIPTION` by hand, and add one test through the real MCP server.

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

`server/index.ts` gets a call and hands it to `run()` in `kernel/host.ts`, which is a pipeline
of separate stages:

1. **Check** (`kernel/check.ts`): wrap the code as an async function body and type-check it
   against `guest.d.ts` with a warm TypeScript program.
2. **Execute** (`kernel/execute.ts`): start a fresh Bun Worker. Each tool call in the program
   comes back to the host as a message and runs from `kernel/tools.ts`. The Worker is
   terminated on a timeout or when the call ends. The messages are typed in
   `kernel/protocol.ts`.
3. **Format and bound** (`kernel/result.ts`): print lines, then the returned value, cut at a
   fixed size. These are pure functions with unit tests.

pi-fabric's self-correcting modules (argument repair, code repair, type-error guidance, output
budget) go in as new stages of this pipeline, each with its own unit tests.

## Docs and scratch

Most changes need no doc change. Rewrite a page instead of adding to it. Plans, inventories and
benchmarks in progress go in `notes/`, which is gitignored.
