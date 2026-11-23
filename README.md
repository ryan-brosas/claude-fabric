# claude-fabric

[pi-fabric](https://github.com/fabric-runtime/pi-fabric)'s `fabric_exec`, ported to Claude Code.

Instead of one tool call per read, search or command, Claude writes one TypeScript program that
makes all of them. claude-fabric type-checks the program, runs it on Bun and sends back only what
the program returns, so the steps in between never fill the context. Inside the program, tools
keep Claude Code's names and fields (`Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`). It is
meant to replace Claude Code's native code mode.

**Alpha.** This alpha version needs more data. The benchmarks below cover short tasks, and there is no
benchmark yet for long work sessions. Another extension is planned to go with it, most likely
`fabric-runtime`.

## Why

We built this because Claude Code's native code mode, and above all its compaction, were not good
enough for our daily work.

Programs are type-checked before anything runs, and common slips are repaired without another model
request. Compaction is deterministic, needs no model call and keeps the user's sentences word for
word. `history.recall` and `history.expand` read what a summary left out, on a best-effort basis.

## Benchmarks

Code mode: Sonnet 5.5, `fabricOnly` on, 15 tasks, 5 runs per arm, 2026-11-23.

| Arm | Runs passing | Mean tokens | Requests per run |
| --- | --- | --- | --- |
| `fabric_exec` | 75 of 75 | 86,046 | 4.40 |
| Native code mode | 73 of 75 | 111,092 | 14.75 |

Compaction: `l3-memory` (100 turns, 6 compactions), DeepSeek v4.1 Flash.

| Arm | Runs passing | Median tokens |
| --- | --- | --- |
| claude-fabric | 18 of 20 | 8.57M |
| Plain Claude Code | 9 of 10 | 9.02M |

These short tasks on two models are evidence for these tasks, not for sessions in general.

[Full record](docs/benchmarks.md)

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
bun run proof:check # proves laws, rejects broken variants and checks generated machines
```

Needs Bun 1.4+ and ripgrep.

The layout is in [docs/internals/architecture.md](docs/internals/architecture.md).

## Credit

The design follows [pi-fabric](https://github.com/fabric-runtime/pi-fabric) by Tom X Nguyen
(MIT), the `fabric_exec` runtime for Pi.

## License

MIT
