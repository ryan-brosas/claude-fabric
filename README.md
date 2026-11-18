# claude-fabric

One tool call for everything in Claude Code. `fabric_exec` runs a type-checked TypeScript
program on Bun. The program calls tools (`pi.read`, `pi.edit`, `pi.bash`, ...) and returns one
bounded result. It replaces Claude Code's native code mode.

Status: phase 0. The kernel works; the MCP server and plugin come next.

## Try the kernel

```sh
bun install
bun run spike      # runs sample programs against this repo and prints timings
bun run typecheck
```

Needs Bun 1.4+ and ripgrep.

## Layout

- `kernel/check.ts`: wraps a program and type-checks it with a warm TypeScript program.
- `kernel/worker.ts`: one fresh Bun Worker per call; `pi.*` calls cross to the host.
- `kernel/host.ts`: check, run, time out, bound the result.
- `kernel/tools.ts`: `pi.*` tool implementations.

## Credit

The design follows [pi-fabric](https://github.com/fabric-runtime/pi-fabric) by Tom X Nguyen
(MIT), the `fabric_exec` runtime for Pi.

## License

MIT
