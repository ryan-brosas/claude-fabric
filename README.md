# claude-fabric

One tool call for everything in Claude Code. `fabric_exec` runs a type-checked TypeScript
program on Bun. The program calls tools (`pi.read`, `pi.edit`, `pi.bash`, ...) and returns one
bounded result. It replaces Claude Code's native code mode.

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
```

Needs Bun 1.4+ and ripgrep.

## Layout

- `kernel/check.ts`: wraps a program and type-checks it with a warm TypeScript program.
- `kernel/worker.ts`: one fresh Bun Worker per call; `pi.*` calls cross to the host.
- `kernel/host.ts`: check, run, time out, bound the result.
- `kernel/tools.ts`: `pi.*` tool implementations.
- `server/index.ts`: MCP server with the one `fabric_exec` tool.
- `server/start.sh`: plugin entry; installs dependencies on first start.

## Credit

The design follows [pi-fabric](https://github.com/fabric-runtime/pi-fabric) by Tom X Nguyen
(MIT), the `fabric_exec` runtime for Pi.

## License

MIT
