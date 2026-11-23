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

The benchmark driver is `bench/run.ts`, and its report is `bench/report.ts`.

On the afternoon of 2026-11-23, `fabric_exec` with `fabricOnly` on passed 75 of 75 runs against
native code mode's 74 of 75, at 0.730 times its mean tokens.

| Arm | Runs passing | Mean tokens | Median tokens | Range | Requests per run |
| --- | --- | --- | --- | --- | --- |
| `fabric_exec`, `fabricOnly` on, native code mode off | 75 of 75 | 83,200 | 78,147 | 52,921 to 163,413 | 4.37 |
| Native code mode | 74 of 75 | 113,965 | 105,287 | 73,438 to 204,995 | 15.52 |

The two arms ran together on 15 tasks, 5 times per arm, on Sonnet 5.5. The `fabric_exec` plugin
included Read's continuation notice (#70) and repairs for type errors and refused writes that cost a
request (#71). It used 0.730 times native code mode's mean tokens and 0.742 times its median.

That morning, with plugin main `42b1fef`, both arms passed 70 of 75. `fabric_exec` had a mean of
87k tokens and a median of 80k, against native code mode's 111k and 106k. The ratios were 0.78 for
the mean and 0.76 for the median. The morning `fabric_exec` arm replaced a run where the driver
typed the prompt but never sent Enter; the replacement passed and its tokens are counted.

Task 06's morning prompt was ambiguous about the format of the `slowest:` line. It failed all 5
runs in every arm. The prompt now gives the format, and the task passed all 5 runs in both afternoon
arms. Pass counts across the two runs are not comparable for task 06: in the morning both arms
passed 70 of 70 runs on the other 14 tasks. Token means in both runs cover all 15 tasks.

In the `fabric_exec` arm, requests that did no work fell from 35 in the morning to 13 in the
afternoon: refused top-level calls from 18 to 0, type-check failures from 15 to 13, and Bash nonzero
exits from 2 to 0.

That evening, a third run used the plugin with #72 and #74 as well, with a native arm alongside.
`fabric_exec` passed 75 of 75 at a mean of 83,950 tokens and median of 75,922 (range 52,971 to
136,643), with 4.37 requests per run. Native code mode passed 74 of 75 at a mean of 112,633 and
median of 106,302 (range 74,953 to 209,984), with 15.44 requests per run. `fabric_exec` used 0.745
times native's mean and 0.714 times its median. It had 11 requests that did no work: 10 type-check
failures and 1 other failed program. Against the afternoon build, there was no measurable change:
requests per run were the same and no pass was lost. The plugin ran #74 without its last two code
commits, which only refuse more inputs. One `fabric_exec` run made 3 top-level Bash calls.

Since the 2026-11-19 run, the changes also include the `fabricOnly` option (#22, #23, #36), program
guidance (#21) and whole-file `Read` guidance (#58, #61). An afternoon arm that added guidance to
chain dependent steps in one program showed no gain: 74 of 75 passed, with a mean of 83,790 tokens
and 4.35 requests per run, so that sentence is not shipped.

On the earlier 2026-11-19 run, with `fabricOnly` off (the default), `fabric_exec` used 1.052 times
native code mode's mean tokens. This remains the only measurement with `fabricOnly` off.

| Arm | Runs passing | Mean tokens |
| --- | --- | --- |
| `fabric_exec` | 70 of 75 | 152k |
| Native code mode | 70 of 75 | 145k |
| Plain Claude Code | 68 of 74 | 167k |

On 2026-11-19, 15 tasks ran 5 times per arm on Sonnet 5.5. One plain run left no record, and one hit
the turn limit, so the plain token mean covers 73 runs. Native code mode's mean fell from 145k then
to 111k in the morning rerun, on a newer Claude Code. Compare arms within the same run, not across
days.

#### DeepSeek through CoralBricks

On 2026-11-23, the same driver ran 15 tasks, 5 times per arm, on `deepseek-v4.1-flash` through
CoralBricks. Both `fabric_exec` arms had `fabricOnly` on. The #70 and #71 arm ran with native code
mode; the main-build arm ran alone right after them.

| Arm | Runs passing | Mean tokens | Median tokens | Range | Requests per run |
| --- | --- | --- | --- | --- | --- |
| `fabric_exec` with #70 and #71 | 75 of 75 | 136,608 | 114,079 | 37,373 to 719,147 | 8.75 |
| `fabric_exec`, plugin main `facb449` | 74 of 75 | 137,575 | 115,958 | 36,404 to 608,701 | 8.45 |
| Native code mode | 75 of 75 | 264,083 | 237,414 | 62,577 to 888,795 | 11.63 |

With #70 and #71, `fabric_exec` used 0.517 times native's mean tokens and 0.481 times its median.
Main had 31 requests that did no work: 18 type-check failures, 12 Bash nonzero exits and 1 other
failed program. The #70 and #71 build had 13: 8 type-check failures, 2 Bash nonzero exits and 3
other failed programs. Neither build had refused top-level calls, so the gain came from repairs, not
wording. The newer build had fewer wasted requests and one more pass, but no token gain. Mean tokens
and requests per run were similar across builds. Main's failed run was `06-runlog-stats-command`.

On the evening of 2026-11-23, the same driver ran 15 tasks, 5 times per arm, with `fabricOnly` on
for the plugin. The plugin also had #72, #74 and the first commit of #76; native code mode ran
alongside. `fabric_exec` passed 74 of 75, with a mean of 127,333 tokens, a median of 115,130, a
range of 33,899 to 468,815 and 8.36 requests per run. Native code mode passed 74 of 75, with a mean
of 240,386 tokens, a median of 226,900, a range of 67,474 to 678,277 and 10.89 requests per run.
`fabric_exec` used 0.530 of native's mean and 0.507 of its median. Each arm failed one run of
`05-router-encoded-path`; no program in the failed `fabric_exec` run was repaired. `fabric_exec` had
19 requests that did no work: 13 type-check failures, 3 Bash nonzero exits and 3 other failed
programs, against 13 in the afternoon. Twelve programs that failed the first check were repaired and
ran without an extra request. On this model, the later repairs show no gain in passes or wasted
requests over the afternoon build; the differences are within what repeated runs of these tasks show.

In one #70 and #71 run of `10-rename-config-settings`, the session never called `fabric_exec` and
used top-level Bash and Write. At its first request, the plugin's MCP server was still connecting, so
`fabric_exec` was not offered. `fabricOnly` hides Bash and Write only while `fabric_exec` is offered,
so the model started with the built-in tools and kept using them.
The run passed, and its 212,143 tokens are counted. These 15 small tasks are evidence for these
tasks, not a claim about sessions in general.

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
