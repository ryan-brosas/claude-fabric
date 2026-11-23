# claude-fabric

[pi-fabric](https://github.com/fabric-runtime/pi-fabric)'s `fabric_exec`, ported to Claude Code.

Instead of one tool call per read, search or command, Claude writes one TypeScript program that
makes all of them. claude-fabric type-checks the program, runs it on Bun and sends back only what
the program returns, so the steps in between never fill the context. Inside the program, tools
keep Claude Code's names and fields (`Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`). It is
meant to replace Claude Code's native code mode.

Status: the plugin exposes `fabric_exec` to Claude Code, with Fabric's self-correcting stages
(argument repair, code repair, output budget, type-error guidance, repeat guard). Its mod provides
a deterministic Fabric summary for compaction. If a transcript rebuild fails, it carries the earlier
Fabric summary. It delegates to Claude Code when an over-budget transcript has no older history to
cut, on an automatic skip, or on an uncaught error or timeout.

## Benchmarks

### Compaction: memory across six compactions

On `l3-memory`, claude-fabric passed 18 of 20 runs at a median 8.57M tokens, 5% under plain Claude
Code's median.

| Compactor | Runs passing | Median tokens | Range |
| --- | --- | --- | --- |
| Plain Claude Code | 9 of 10 | 9.02M | 8.70M to 10.24M |
| claude-fabric before | 10 of 10 completed | 13.48M | 9.71M to 17.27M |
| claude-fabric now | 18 of 20 | 8.57M | 8.16M to 9.02M |

`l3-memory` is a 100-turn session with 6 compactions and 14 facts stated only in the conversation:
settings, later corrections and one constraint. A checker grades the files the model writes at the
end. All rows use DeepSeek v4.1 Flash; plain Claude Code uses its own compaction. Plain Claude Code
and the first claude-fabric comparison ran on 2026-11-21; the current runs ran on 2026-11-22 on
main `f92d000`. The first claude-fabric comparison had 10 scored runs; its final summaries held 92
of 140 facts. Of the 48 missing, the trace report attributes 44 to recall and 2 to direct reads of
the transcript file; 2 have no established source. One additional attempt did not complete:
a 15-minute marker timeout after 46 turns. It was replaced, had no token count, and its cause is
unproven. The before arm's token figures cover the 10 completed runs.

In each of the 20 current runs, the final summary after the sixth compaction held all 14 facts:
280 of 280. Each was the user's own sentence, word for word, not a paraphrase. The benchmark scorer
graded this result, and its own audit passed.

Both failed current runs wrote one list setting as strings instead of integers, though all four
values were in their final summaries. Plain Claude Code's one failed run had the same type slip.
The worst current run used 1.05 times the median tokens. Replaying recorded transcripts through the
compactor showed that none of the 120 compactions carried an earlier Fabric summary or delegated to
Claude Code; this was not established from live hook logs.

A second task, `l3-parallel`, has 28 turns and 3 compactions, with parallel tool calls right before
each compaction. It passed 10 of 10 runs and 100 of 100 checks. Replay found that none of its 30
compactions carried an earlier Fabric summary or delegated to Claude Code.

After compaction, a kept whole-file `Read` result over 16,384 bytes is replaced by a stub naming
the file, its size, the transcript entry and a SHA-256 only if the result is text-only, verifies
against the transcript and the stub is at most 1,024 bytes; otherwise the result stays as it was
(#66). Before this change, the median was 9.63M tokens over 20 runs.

The DeepSeek comparisons cover one task family on one inexpensive model, with 20 and 10 runs.
Token counts are mostly cache reads. This is evidence for these tasks, not a claim about sessions in
general. On Sonnet 5.5, `l3-memory` passed 5 of 5 runs at 15.4M to 15.8M tokens; there is no
plain-Claude Sonnet number for comparison.

### Code mode: `fabric_exec` against native code mode

On 2026-11-23, `fabric_exec` with `fabricOnly` on passed as many runs as native code mode, at
0.78 times its mean tokens.

| Arm | Runs passing | Mean tokens | Median tokens |
| --- | --- | --- | --- |
| `fabric_exec`, `fabricOnly` on, native code mode off | 70 of 75 | 87k | 80k |
| Native code mode | 70 of 75 | 111k | 106k |

The two arms ran together on the same 15 tasks as the earlier run, 5 times per arm, on Sonnet 5.5,
Claude Code 2.1.330 and plugin main `42b1fef`. `fabric_exec` used 0.78 times native code mode's
mean tokens (87,053 against 111,020) and 0.76 times its median (80,486 against 106,439). Its mean
was lower on all 15 tasks.
Both arms failed `06-runlog-stats-command` in all 5 runs and passed every other run. Mean wall time
per run was 36 s for `fabric_exec` and 30 s for native code mode.

One `fabric_exec` run was replaced: the driver typed the prompt but the session never received Enter,
so no session ran; the replacement needed Enter pressed by hand, then passed, and its tokens are
counted. No plain Claude Code arm ran this time.

Since the 2026-11-19 run, the changes are the `fabricOnly` option (#22, #23, #36), program guidance
(#21) and whole-file `Read` guidance (#58, #61).

On the earlier 2026-11-19 run, with `fabricOnly` off (the default), `fabric_exec` used 1.052 times
native code mode's mean tokens. This remains the only measurement with `fabricOnly` off.

| Arm | Runs passing | Mean tokens |
| --- | --- | --- |
| `fabric_exec` | 70 of 75 | 152k |
| Native code mode | 70 of 75 | 145k |
| Plain Claude Code | 68 of 74 | 167k |

On 2026-11-19, 15 tasks ran 5 times per arm on Sonnet 5.5. One plain run left no record, and one hit
the turn limit, so the plain token mean covers 73 runs. Native code mode's mean fell from 145k then
to 111k in the rerun, on a newer Claude Code, so compare arms within one day, not across the two
dates. These 15 small tasks on one model are evidence for these tasks, not a claim about sessions in
general.

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
