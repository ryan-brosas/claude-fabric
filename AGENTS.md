# claude-fabric

A Claude Code plugin that ports [pi-fabric](https://github.com/fabric-runtime/pi-fabric)'s
runtime to Claude Code, starting with `fabric_exec` and its compactor. The goal is for Claude to
use `fabric_exec` instead of Claude Code's native code mode. It has to earn that in the benchmark
(step 6 below); until then, that it saves tokens is a hypothesis.

## What we're building

- **One tool, `fabric_exec`.** Claude sends one TypeScript program. The program reads, searches,
  edits and runs commands through `Read`, `Write`, `Edit`, `Grep`, `Glob` and `Bash`, and the
  web through `WebSearch`, with the same names and fields as Claude Code's own tools. Independent calls run in parallel with
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
2. **Done:** the `src/` layout in architecture.md, the action registry that generates guest
   types, tool lines and argument checks, and an empty mod that loads.
3. **Done:** the deterministic compactor in `src/compaction/` answers `session.compact` with a
   Fabric summary and no model call. If a transcript rebuild fails, it keeps the earlier Fabric
   summary. It delegates to Claude Code when an over-budget transcript has no older history to cut,
   on an automatic skip, or on an uncaught error or timeout. Its cut and allocation rules are
   gdp-wired kernels in `proofs/`.
4. **Done, the self-correcting stages** (argument repair, code repair, output budget, type-error
   guidance, repeat guard), copied with MIT credit. The repeat guard's counting rule
   (`proofs/repeat-guard.ts`) and the output budget's length arithmetic
   (`proofs/output-budget.ts`) are gdp-wired kernels too, compiled into
   `src/stages/verified/generated/`; those two stages decide through the compiled machines.
5. **Done:** `store`/`load`, the session store a program keeps between calls;
   `mcp.<server>.<tool>()`, so a program calls the session's other MCP servers through the mod's
   `$.mcp.call`, over a Unix socket bridge, and the server keeps no MCP client; and `WebSearch`,
   the one built-in a program may call through the mod's `$.tool.call`, over the same job queue,
   because that call skips the person's permission prompts and deny rules. `Agent` and every
   other built-in stay top-level only. Prompt guidance is done too: one `fabric:guidance`
   system prompt section appended by `prompt.compose` when the pool holds `fabric_exec`. **Next:**
   `__bun`, tool middleware, agents and mesh, in the order architecture.md's probes allow.
6. **Done, the benchmark:** plain Claude, Claude with native code mode, and Claude with
   `fabric_exec` (code mode off), on 15 tasks, 5 runs each, on Sonnet 5.5, on 2026-11-19.
   `fabric_exec` solved 70 of 75, the same as native code mode, at 1.052 times its tokens (152k
   against 145k mean), so it passes. Plain Claude solved 68 of its 74 recorded runs at 167k. It took the deferred
   tool list by server (#16) and guidance that says to reach for `fabric_exec` first (#17).
7. **Next:** turn native code mode off. A mod cannot do it cheaply: hiding `REPL` and `Poll`
   with code mode on loads every MCP tool's schema (103k tokens on the first call, against 26k).
   So the switch is `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=0`, which is what the benchmark's
   `fabric_exec` arm ran with. What is left is dogfooding: daily sessions with the plugin and
   code mode off. Two tuning steps came out of the benchmark: guidance on how to write a program
   (#21), and the `fabricOnly` option (#22, #23), which keeps Bash, Edit, Write, Grep and Glob from
   the main conversation so its work goes through programs. On Haiku the two together cut mean
   tokens from 363k to 277k, all 15 runs passing; the option is off by default and on in the
   dogfood setup.

Each step's details and the things we chose not to build are in
[docs/internals/decisions.md](docs/internals/decisions.md).

The user's global `AGENTS.md` supplies standing rules. This file adds project context, not
exceptions. If a rule here fights the task, say so loudly.

Words: [CONTEXT.md](CONTEXT.md) is the glossary. Use its terms in code, tests and PR text.
Read [docs/internals/decisions.md](docs/internals/decisions.md) before you add scope.

## What we never compromise on

1. **Claude Code's vocabulary, not Pi's.** Program tools are `Read`, `Write`, `Edit`, `Grep`,
   `Glob`, `Bash` and `WebSearch`, with Claude Code's field names. Model-facing text never says `pi.`.
   Enforced by `test/server/server.test.ts` ("lists exactly one tool").
2. **Nothing runs until it type-checks.** A type error returns line numbers, and no tool call
   happens. Enforced by the "type error is reported and nothing runs" test and the spike.
3. **One bounded result.** Only the return value and `print()` lines reach the model, and
   they are cut at a fixed size (`src/kernel/result.ts`).

## The ways to hurt yourself

1. **Writing to the MCP server's stdout.** stdout is the MCP stream. A `console.log` in the
   server, or install output, corrupts it. `src/server/start.sh` sends `bun install` to stderr for
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

Each program tool is defined once, in `src/providers/tools/`. `src/providers/tools/index.ts`
holds the one list, `TOOLS`. Everything else is printed from that list by
`src/registry/generate.ts`: the types the checker gives programs (`guestTypes`), the tool lines
of the model-facing `DESCRIPTION` (`toolLines`), and the runtime argument check (`parseArgs`).
The host sends the tool names to the Worker, so the Worker imports no providers.

A changed field changes one provider file. `test/registry/generate.test.ts` prints the types
and fails if they drift from `TOOLS`, and `test/server/server.test.ts` calls the tool through
the real MCP server with a bad argument, so a field the model must fill fails there too.

The mcp surface is printed from runtime data instead: `src/registry/mcp.ts` prints its
declarations and its one DESCRIPTION line from the session's catalog, and `src/kernel/mcp.ts`
resolves a call against that same catalog, so a name the check accepts is a name the host
resolves. The mod API exposes no input schemas for a session's MCP tools, so arguments are one
loose object in the declarations and the server checks them at dispatch.

## Check

```sh
bun run typecheck && bun run spike && bun run test && bun run proof:check
```

CI runs the same four on Bun 1.4.0 with ripgrep. `proof:check` proves every law in `proofs/`,
refuses every broken variant, and compares the compiled machines with the committed generated
files; `proof:write` regenerates them. `spike` runs sample programs against this
repo and prints timings. `test` starts the real MCP server over stdio and calls `fabric_exec`.
Green doesn't prove the plugin loads in Claude Code. For that, run
`claude --plugin-dir .` and call the tool, which shows up as
`mcp__plugin_fabric_fabric__fabric_exec`.

The mod needs Claude Code for its checks, so CI does not run them. `claude plugin validate .`
reads the manifest and the mod as Claude Code will. `bun run typecheck:mod` types `src/mod/`
against `.claude-plugin/types/`, which Claude Code writes when an interactive session loads the
plugin. `claude --debug-file <f> -p --plugin-dir . ...` proves the load: the log says
`hooks module fabric@inline loaded`. Don't run `claude plugin test .` here: it loads every
`*.test.ts` in the folder as a mod test, upstream's and the Bun tests included.

## How it works

`src/server/index.ts` gets a call, repairs its arguments and hands it to `run()` in
`src/kernel/host.ts`, a pipeline of separate stages. Each stage that corrects the model is a pure
module in `src/stages/` with its own unit tests in `test/stages/`.

1. **Arguments** (`src/stages/args.ts`, in the server): a program sent as lines joins into one
   string, payloads sent as JSON text (or under the old `strings` alias) become the record, display
   is normalized, and keys this tool does not declare are dropped. The MCP input schema is loose
   enough for those repairs to reach `prepareArguments`; the strict envelope judges the call after.
2. **Code repair** (`src/stages/code-repair.ts`, only after a failed check): unquoted path and URL
   arguments and Unicode quotes in path positions are quoted, and the repaired program runs only if
   it passes the check. A program that already passes is never rewritten. Grep's pattern and Bash's
   command are never touched.
3. **Check** (`src/kernel/check.ts`): wrap the code as an async function body and type-check it
   against the declarations from `src/registry/generate.ts` with a warm TypeScript program.
4. **Type guidance** (`src/stages/type-guidance.ts`, after a failed check): a misplaced envelope
   argument, an unknown field on a tool input (named with that tool's real fields), a `Promise.all`
   arity mismatch and a Pi or Node global each get one short hint under the check's own lines.
5. **Repeat guard** (`src/stages/repeat-guard.ts`, one per server process): identical programs with
   identical payloads are counted; the third run warns inside the result, the sixth is blocked
   before anything runs.
6. **Execute** (`src/kernel/execute.ts`): start a fresh Bun Worker. Each tool call in the program
   comes back to the host as a message; the host turns the raw arguments into that action's input
   and runs it. An `mcp.<server>.<tool>()` call is one message whose action is not a provider
   function: `src/kernel/mcp.ts` checks the access rule and sends one job over the bridge.
   `WebSearch` is the other: its provider's `run` sends a built-in tool job, which
   `src/kernel/builtin.ts` lets through only for a tool in the fixed allowlist and the mod runs
   with `$.tool.call`. Every message passes the run's gate first (`src/kernel/verified/gate.ts`, rule and
   laws in `proofs/gate.ts`): it must carry the run's token, no tool call is acted on after the
   done, and at most one done is admitted. The Worker is terminated on a timeout or when the call
   ends. The messages are typed in `src/kernel/protocol.ts`.
7. **Store** (`src/kernel/store.ts` with `src/stages/store.ts`): one store per server process, in
   memory. A run gets a JSON snapshot with its run message; `store()` stages a write and `load()`
   returns a copy, with no tool call crossing the bridge. The host commits the staged writes only
   when the program succeeded, and a value over 262144 JSON chars or a store over 1048576 fails
   the program naming the key and the limit. Both rules are the compiled machine in
   `src/stages/verified/` (`proofs/store-limits.ts`).
8. **Result** (`src/kernel/result.ts` with `src/stages/output-budget.ts`): print lines, then the
   returned value. Over the cap, the middle is cut out and the whole text goes to a new private
   file whose path ends the result; if that file cannot be written, the kernel's own cut applies.

## Docs and scratch

Most changes need no doc change. Rewrite a page instead of adding to it. Plans, inventories and
benchmarks in progress go in `notes/`, which is gitignored.
