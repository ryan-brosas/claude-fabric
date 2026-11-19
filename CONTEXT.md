# claude-fabric

The words that steer decisions here. Add a term only when two words for one thing, or one
word for two things, caused a wrong move.

**fabric_exec**:
The one MCP tool this plugin exposes. One call runs one program.
_Avoid_: code mode (that is Claude Code's built-in feature, which this replaces)

**Program**:
The TypeScript a model sends in `code`. It is an async function body, so top-level `await` and
`return` work.
_Avoid_: script, snippet, guest code (except inside the kernel)

**Program tool**:
A function a program calls: `Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`. Each has the same
name and fields as the Claude Code tool. One string means the main field.
_Avoid_: action, pi.read and the other Pi names

**Top-level tool**:
A tool the model calls directly, outside a program. Claude's built-ins (WebSearch, Agent, Skill)
stay top-level because an MCP server can't reach them.

**Native code mode**:
Claude Code's own code-execution tool (the REPL), switched by
`CLAUDE_CODE_EXPERIMENTAL_CODE_MODE`. It's the baseline we benchmark against.
_Avoid_: REPL mode, code mode (alone)

**Kernel**:
`src/kernel/`: check, run and bound a program. It has no MCP code.
_Avoid_: runtime, engine

**Check**:
The type-check of a program against the declarations the program tools generate, run before
every call with a warm TypeScript program. A failed check means nothing ran.
_Avoid_: validate, lint

**Host**:
The server-side half of a call. It runs the check, starts the worker, serves tool calls and
cuts the result.

**Worker**:
The fresh Bun `Worker` thread a program runs in, one per call. It is an execution thread, not
an agent and not a security sandbox: a program can reach Bun's globals, not only the program
tools.
_Avoid_: agent, child, sandbox

**Payloads**:
Named strings sent beside `code`, which a program reads as `π.<key>`. They carry long or
syntax-heavy text so it isn't escaped into code.
_Avoid_: args, inputs

**Result**:
What reaches the model: `print()` lines, then the returned value, cut at a fixed size.
_Avoid_: output (for Bash, `output` is the command's text)

**Upstream**:
pi-fabric, the reference implementation by Tom X Nguyen (MIT), cloned at `upstream/pi-fabric`.
_Avoid_: Fabric (alone, when you mean the upstream code)
