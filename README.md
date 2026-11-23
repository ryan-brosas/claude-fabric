# claude-fabric

[pi-fabric](https://github.com/fabric-runtime/pi-fabric)'s `fabric_exec`, ported to Claude Code.

Instead of one tool call per read, search or command, Claude writes one TypeScript program that
makes all of them. claude-fabric type-checks the program, runs it on Bun and sends back only what
the program returns, so the steps in between never fill the context. Inside the program, tools
keep Claude Code's names and fields (`Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`). It is
meant to replace Claude Code's native code mode.

Status: the plugin exposes `fabric_exec` to Claude Code, with Fabric's self-correcting stages
(argument repair, code repair, output budget, type-error guidance, repeat guard). Its mod provides
a deterministic Fabric summary for compaction. If a transcript rebuild fails, it keeps the earlier
Fabric summary. It delegates to Claude Code when an over-budget transcript has no older history to
cut, on an automatic skip, or on an uncaught error or timeout.

## Benchmarks

### Compaction: memory across six compactions

On `l3-memory`, claude-fabric passed 18 of 20 runs at a median 8.57M tokens, 5% under plain Claude
Code's median.

| Compactor | Runs passing | Median tokens | Range |
| --- | --- | --- | --- |
| Plain Claude Code | 9 of 10 | 9.02M | 8.70M to 10.24M |
| claude-fabric before | 10 of 10 | 13.48M | 9.71M to 17.27M |
| claude-fabric now | 18 of 20 | 8.57M | 8.16M to 9.02M |

`l3-memory` is a 100-turn session with 6 compactions and 14 facts stated only in the conversation:
settings, later corrections and one constraint. A checker grades the files the model writes at the
end. All rows use DeepSeek v4.1 Flash; plain Claude Code uses its own compaction. Plain Claude Code
and the first claude-fabric comparison ran on 2026-11-21; the current runs ran on 2026-11-22 on
main `f92d000`. The first claude-fabric comparison had 10 scored runs; its final summaries held 92
of 140 facts, and the model got the rest back with recall. `TODO(facts-kept)`: the number of 280
fact-and-run cells present in the current final summaries is pending.

Both failed current runs wrote one list setting as strings instead of integers, though all four
values were in their final summaries. Plain Claude Code's one failed run had the same type slip.
The worst current run used 1.05 times the median tokens. Replaying recorded transcripts through the
compactor showed that 0 of 120 compactions fell back to Claude Code's own summary; this was not
established from live logs.

A second task, `l3-parallel`, has 28 turns and 3 compactions, with parallel tool calls right before
each compaction. It passed 10 of 10 runs and 100 of 100 checks; 0 of 30 compactions fell back.

After compaction, a kept whole-file `Read` result over 16,384 bytes is replaced by a stub of at
most 1,024 bytes that names the file, its size, the transcript entry and a SHA-256 (#66). Before
this change, the median was 9.63M tokens over 20 runs.

The DeepSeek comparisons cover one task family on one inexpensive model, with 20 and 10 runs.
Token counts are mostly cache reads. This is evidence for these tasks, not a claim about sessions in
general. On Sonnet 5.5, `l3-memory` passed 5 of 5 runs at 15.4M to 15.8M tokens; there is no
plain-Claude Sonnet number for comparison.

### Code mode: `fabric_exec` against native code mode

`fabric_exec` solved as many runs as native code mode, but used 1.052 times its tokens.

| Arm | Runs passing | Mean tokens |
| --- | --- | --- |
| `fabric_exec` | 70 of 75 | 152k |
| Native code mode | 70 of 75 | 145k |
| Plain Claude Code | 68 of 74 | 167k |

On 2026-11-19, 15 tasks ran 5 times per arm on Sonnet 5.5. `fabric_exec` costs slightly more than
native code mode, not less. One plain run left no record, and one hit the turn limit, so the plain
token mean covers 73 runs.

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
