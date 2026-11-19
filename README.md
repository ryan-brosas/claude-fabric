# claude-fabric

[pi-fabric](https://github.com/fabric-runtime/pi-fabric)'s `fabric_exec`, ported to Claude Code.

Instead of one tool call per read, search or command, Claude writes one TypeScript program that
makes all of them. claude-fabric type-checks the program, runs it on Bun and sends back only what
the program returns, so the steps in between never fill the context. Inside the program, tools
keep Claude Code's names and fields (`Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`). It is
meant to replace Claude Code's native code mode.

Status: phase 1. The plugin exposes `fabric_exec` to Claude Code. Fabric's self-correcting
modules (argument repair, code repair, output budget, type-error guidance) come next.

## Install

In Claude Code:

```
/plugin marketplace add ryan-brosas/claude-fabric
/plugin install fabric@fabric-exec
```

Needs Bun 1.4+ and ripgrep on PATH. The first start runs `bun install` inside the plugin folder.
The tool shows up as `mcp__plugin_fabric_fabric__fabric_exec`.

To try a local checkout: `claude --plugin-dir /path/to/claude-fabric`.

## Develop

```sh
bun install
bun run spike      # runs sample programs against this repo and prints timings
bun run typecheck
bun run test       # starts the MCP server over stdio and calls fabric_exec
bun run proof:check # proves the compaction laws and matches the generated machines
```

Needs Bun 1.4+ and ripgrep.

## Layout

- `src/kernel/check.ts`: wraps a program and type-checks it with a warm TypeScript program.
- `src/kernel/worker.ts`: one fresh Bun Worker per call; tool calls cross to the host.
- `src/kernel/host.ts`: check, run, time out, bound the result.
- `src/registry/`: `defineAction`, and the types, tool lines and argument check generated from it.
- `src/providers/tools/`: one file per program tool: `Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`.
- `src/server/index.ts`: MCP server with the one `fabric_exec` tool.
- `src/server/start.sh`: plugin entry; installs dependencies on first start.
- `src/compaction/`: the deterministic compactor: Claude Code's transcript in, Fabric's summary out.
- `src/mod/index.ts`: the in-process half of the plugin: answers `session.compact`.
- `proofs/`: the gdp-wired kernels behind the summary and the cut, with their laws; `bun run proof:check`.
- `hooks/hooks.json`: points Claude Code at the mod.

## Credit

The design follows [pi-fabric](https://github.com/fabric-runtime/pi-fabric) by Tom X Nguyen
(MIT), the `fabric_exec` runtime for Pi.

## License

MIT
