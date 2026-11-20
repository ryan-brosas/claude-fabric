# Decisions

What shapes claude-fabric, and why. Rewrite an entry when it changes; don't add a second one.

## Shape

- **A port of pi-fabric's whole runtime to Claude Code** (the user's call, 2026-11-18). It is
  not a fork: each part is rebuilt on the Claude Code surface that fits it, copying Pi-free modules
  with MIT credit. [architecture.md](architecture.md) maps every part to its surface and marks
  what is proven, documented or a gap.
- **A mod plus an MCP server.** The mod runs inside Claude Code and handles compaction, prompt
  sections, tool middleware, commands and UI. The MCP server serves `fabric_exec` and does the
  heavy work. The mod stays thin because of its 10 s hook budget and import limits.
- **Fabric's compactor replaces Claude Code's.** A `session.compact` hook that returns
  `{ messages }` answers in core's place, with no model call (proven 2026-11-18). When a transcript
  over the budget has no older history to summarize (one long turn, or one long turn after a
  summary), the hook hands the event back to core with `next(e)` instead of vetoing it
  (`proofs/no-cut.ts` decides core or skip on that path). It also delegates an automatic skip:
  the text projection cannot count images, so core may need to compact even when Fabric finds
  nothing to summarize. A manual or plugin skip stays with Fabric, subject to the transcript
  rebuild below. `precompute` answers `{ skip }`: there is nothing to compute ahead of time.
  If the hook throws or times out, it logs the failure kind and reason to debug and delegates;
  a failed log cannot block the fallback.
- **A later Fabric compaction rebuilds from the transcript.** The `[Fabric summary]` header
  marks the earlier summary. The mod walks the transcript's active chain and joins its raw prefix
  to the first current message whose handle is on that chain. The chain shape was observed on
  Claude Code 2.1.329. If the transcript or join fails, the mod logs why and carries the earlier
  summary instead. The summary shares a 32 KiB ceiling. The request and recent exchanges have room
  first. Earlier user messages take the room they leave, up to 22 KiB for the section and 4 KiB
  per message. After them, the dialogue section keeps the closing bytes of up to 64 earlier assistant
  replies, up to 256 bytes each. The Carry and operational history share the remaining room
  (`summaryCarry`). When the Carry must shrink, it keeps its start and end and names the middle cut.
- **Claude Code names, no Pi vocabulary** (the user's call, 2026-11-18). Kept from Fabric: the
  one-string shorthand, and `Bash` rejecting on a nonzero exit (`allowFailure: true` opts out).
- **One system prompt section, added by `prompt.compose`.** It teaches when to reach for
  `fabric_exec` and what a program keeps: one program instead of many tool calls, the program tools
  by their Claude Code names, `Promise.all` for independent calls, and only the result or
  `print()` lines entering context. `prompt.compose` is the hook because its event carries the
  session's tool pool and its result is the whole ordered list: the section is added last as
  `session` only when the pool holds `mcp__plugin_fabric_fabric__fabric_exec`, and a recompose
  that already holds the id is left alone. `prompt.section` rewrites one named section and carries
  no pool, so it cannot gate on the tool. The text is capped at 900 chars (745 now) because every
  turn pays for it and step 6 allows at most 10% more tokens than native code mode. Its tool names
  are generated from `providers/tools/names.ts`, a names-only list beside `TOOLS`: the hooks
  worker refuses the zod import every provider pulls in, so the mod cannot read `TOOLS` itself, and
  a test fails if the two lists drift. Dropped from upstream, because Claude Code has no surface for
  them or they do not earn their tokens: payloads and display guidance, tool discovery, the
  extension roster, schema modes, background tasks, Python, model guidance, and the generic working
  discipline (hypothesis, persistence). `core-override-guidance` is absent entirely: it needs
  captured core overrides.
- **`fabric_exec` stays an MCP tool.** Claude passes `CLAUDE_PROJECT_DIR` and
  `CLAUDE_CODE_SESSION_ID` to the server. A mod can also register tools, but the type checker and
  Worker can't run inside the hooks worker.
- **A fresh Bun Worker per call.** It costs about 1.3 ms, against 14 ms for `Bun.spawn`. Node's
  `vm` is faster but gives no thread to terminate. `terminate()` handles timeouts.
- **A warm type checker in the server, run before every call.**
- **A program reaches the session's other MCP servers through the mod, not an MCP client of its
  own.** `mcp.<server>.<tool>(args)` is one job to the mod over a Unix socket, and the mod runs
  it with `$.mcp.call` on Claude Code's own connection and credentials, claude.ai connectors
  included. The socket lives at `<CLAUDE_PLUGIN_DATA>/bridge/<name>.sock`, where the name is the
  session id's first 20 letters and digits: a full UUID put an installed plugin's socket over the
  Unix limit. Its folder is 0700, and a per-session secret written 0600 beside it is required on
  every request, so another local process that finds the socket cannot drain or answer jobs. The
  secret file names the full session id above the secret, and a mod uses it only when that id is
  its own (`proofs/bridge-binding.ts`), so a session that shares the name never runs another
  session's jobs. One process serves a name: a start takes `<name>.lock` with an exclusive create, refuses while that lock's pid is
  alive, refuses a lock it cannot read or that holds no pid, and clears a dead pid's lock and
  tries once more. The pid is linked into place, so a lock is never seen half-written. Only the
  holder unlinks a stale socket, writes the secret and binds; close runs once and removes the
  secret then the lock last. Not closed: two starts that judge the same stale lock dead can both
  take it in turn. Claude Code starts one server per session, so we leave it. The server fails a call at once when no mod is polling, and after
  60 s without an answer. The declarations name the session's servers and tools, from the
  catalog the mod's `tool.list` hook sends each time the engine raises it. The mod API exposes
  no input schemas for a session's MCP tools, so a call's arguments are one loose object in the
  check and the server checks them; a tool the catalog did not hold still compiles and is
  refused at dispatch. A result comes back as its text blocks joined plus its
  `structuredContent`; an `isError` result rejects, so a program can catch it. Programs may call
  only a pair the catalog holds, never this plugin's own server: the access rule is a gdp-wired
  kernel ([proofs/mcp-access.ts](../../proofs/mcp-access.ts)), and the host sends a job only
  through its verdict. The tool-name spelling takes the server at the first `__` after `mcp__`
  and refuses a name with a second, overlapping or later `__`, so a server or tool whose own
  name holds `__` is left out of the catalog instead of being split at a guessed boundary. A
  name a program writes resolves its exact raw server or tool first, then a sanitized alias, so
  `mcp["a_b"]` reaches the server really named `a_b` even when `a-b` is also connected, and the
  lookup's answer is a tag, so a server or tool really named `none` is still callable.
- **A program reaches one built-in tool, WebSearch, and nothing else** (the user's call,
  2026-11-19). The mod's `$.tool.call` skips the person's permission prompts and deny rules: it
  runs the tool as the plugin, with nobody asked. So a program that could name a built-in tool at
  all could reach every one of them, `Agent` included. The list is fixed in
  `src/bridge/contract.ts` (`BUILTIN_TOOLS`, whose one entry is `WebSearch`); the host sends a
  job only through the gdp-wired access rule
  ([proofs/builtin-access.ts](../../proofs/builtin-access.ts)), and the mod refuses a job naming
  any other tool before it calls one, so a host bug is not a second way in. `Agent` and the rest
  stay top-level only. A program's `WebSearch({ query, allowed_domains?, blocked_domains?,
  mode? })` keeps Claude Code's own name and fields, defaults `mode` to `"standard"` (an
  `"extended"` search costs several times more) and returns `{ text, results }`: the text the
  model would read, and the hits flattened out of `result.results`. Both job kinds ride one queue
  and one answer path, so a call fails the same way whether the mod is absent, slow or refused the
  job.
- **The mod spells every `$` call inside a hook body.** The hooks compiler refuses a `$` bound,
  passed, spread, returned or read, so a `$` cannot be handed to a helper or another module: the
  loop and every `$.http.fetch`, `$.mcp.call`, `$.process.hookEnv`, `$.fs.read` and `$.session.id` sit
  inside a hook body in `src/mod/index.ts`, and `src/mod/bridge.ts` builds the request, parses the
  job, shapes the answer and backs off on plain data alone. One check came out of this that no
  type-check sees: `test/mod/imports.test.ts` reads `src/mod/` with the TypeScript parser and fails
  on a `$` used as a value, in the compiler's own words.
- **`store`/`load` live in the server's memory, and a run's writes commit only on success.** The
  worker gets a snapshot with its run message and stages `store()` calls; the host commits them
  after the program succeeds, so a program that fails, times out or crashes changes nothing. One
  store per server process, which is one session. The limits and the commit rule are a gdp-wired
  kernel ([proofs/store-limits.ts](../../proofs/store-limits.ts)). Not on disk in this slice: the
  store dies with the session, and `CLAUDE_PLUGIN_DATA` is for what has to outlive it.
- **A fabric session's deferred tool list names servers, not tools.** With code mode off, Claude
  Code lists every deferred tool by name on each request; the benchmark pilot measured that list
  at about 28k characters, while native code mode sends a short server list. While `fabric_exec`
  is in the pool, the mod's `prompt.attachment` hook rewrites that one section to built-ins by name
  and one `mcp__<server>__* (N tools)` line per server (`src/mod/deferred.ts`). ToolSearch still
  finds every tool. Other sections, and any text a section holds that is not a tool name, pass
  through unchanged. The person approved this on 2026-11-19.
- **The step 6 benchmark ran on Sonnet 5.5.** The person asked for Sonnet to save usage; every arm
  used the same model. 15 tasks (bug fixes, features, refactors, investigations), each with a hidden
  check, 5 runs per arm, each run an interactive session in tmux, since code mode runs only there.
  Tokens are a run's input, cache and output tokens summed over its API calls. Result: `fabric_exec`
  70/75, native code mode 70/75, plain 68/74 (one plain run of task 12 left no record, and one hit the turn limit, so its token mean covers 73 runs), `fabric_exec` at 1.052
  times native's tokens. Task 06 failed every run of every arm, and nothing else failed: its prompt leaves the output
  calls and the `slowest` format open, and its check expects one form of each.

## Trust

- **The worker is not a security sandbox.** Programs run in an ordinary Bun Worker. The type
  checker hides Bun's globals, but `globalThis as any` still reaches `Bun`, `fetch` and
  `process`, so a program isn't limited to the program tools. So they run only at the
  trust given to `fabric_exec`. pi-fabric's default is different: a QuickJS sandbox with no
  filesystem, network or process, where every effect goes through the host. pi-fabric itself
  calls its Node-process mode "not a security boundary". Open: whether to move to a sandbox
  before the repo goes fully public.
- **No approval layer.** Programs run at the trust given to `fabric_exec`; the target is auto
  mode. Other permission modes come later.
- **The mod confirms a job before it runs it.** A poll's response can be lost on the way, and the
  server cannot tell. So the mod posts `/receipt` and runs the job only if the server accepts it; a
  handed job with no receipt fails after 5 s ("never confirmed ... so it was not run") instead of at
  the 60 s answer limit, and an answer for an unconfirmed job is refused. Nothing is ever resent, so
  no MCP or WebSearch effect can run twice. The rule is a gdp-wired kernel
  ([proofs/job-receipt.ts](../../proofs/job-receipt.ts)).
- **No background shell tasks.** `Bash` waits. A long job sets the call's `timeout` (default
  120000 ms, at most 600000, Bash's own foreground limit; `proofs/call-timeout.ts`). Every command
  runs in its own process group, which is stopped when its program ends, so nothing a program
  started outlives it. Past Claude Code's 120 s MCP wait, the call moves to the background and its
  result arrives as a notification.

## Planned, not built

- `__bun`: Bun inside programs, with writes, spawns and deletes logged to a journal. Upstream it
  is `declare const __bun: any`, the raw Bun module. That breaks architecture rule 6 (every effect
  crosses one bridge) and ties the runtime to the unsandboxed Worker, so it waits on the sandbox
  question under Trust.
- **Tool middleware: nothing to port alone** (checked 2026-11-19). pi-fabric's `tool_call` and
  `tool_result` hooks fix Pi's ignored `isError` (Claude Code honours it), expand Pi's skill-folder
  markers in `read` results, merge approval usage (there is no approval layer here), and hand a
  result to a child or guard a child's writes (`agents/write-guard.ts`). The last two are part of
  agents.
- Agents and mesh: these need a program to start an agent, and `Agent` stays top-level only.
  The mechanism exists (architecture.md, Answered probes: `$.agent.spawn`, the answer at
  `turn.complete`); a spawned agent then runs with no permission prompt from the person, so
  opening it to programs is the person's decision, not a port step.
- After the benchmark, native code mode is turned off with `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=0`,
  not by a mod: hiding `REPL` from the tool list with code mode on put every MCP tool's schema in
  the prompt (103k tokens on the first call, 313k once all servers connected). Every other tool
  stays visible unless the person turns on `fabricOnly`.
- **`fabricOnly`, off by default** (plugin.json `userConfig`, `src/mod/fabric-only.ts`). pi-fabric's
  full code mode, cut down: with code mode off, the mod's `tool.offer` hook keeps Bash, Edit, Write,
  Grep and Glob from the main conversation's model while `fabric_exec` is in the pool. Agents keep
  every tool, and the pool is untouched, so `$.tool.call` still reaches them; `tool.list` was tried
  first and removes a tool from the whole session, agents and the mod included. Read stays for images
  and PDFs, and WebSearch because a program's WebSearch skips the person's permission prompts. The
  main conversation also loses Bash's background jobs (a program's Bash waits, within the call's
  `timeout`). It is an option, not the default, because it changes every session. An env var cannot
  carry it: `$.process.hookEnv` returns only Claude Code's own variables. The rule is a gdp-wired
  kernel, `proofs/tool-visibility.ts` (5 laws, 6 broken variants refused), and the hook hides a tool
  only through its compiled verdict. Its answer per loop and tool is fixed at the first ask
  (`proofs/offer-memo.ts`) and dropped at `session.end`: a first ask before `fabric_exec` joined
  had left Bash in the model's list while its calls were refused, which failed 4 of 15 Haiku runs.
- **`fabricOnly` also moves the other built-ins behind ToolSearch** (`deferredByOption`, through the
  `tool.describe` hook). Interactive Claude Code with code mode off sends 22k tokens of built-in
  schemas on every request; native code mode sends 4.5k. Read, Skill and ToolSearch stay in the
  list, the hidden tools stay loaded for agents, and every other built-in is one ToolSearch away.
  The first request fell from 33.5k tokens to 11.9k. Haiku 5.5, 15 tasks x 3, 2026-11-19, against
  native code mode with the user's settings kept out (`--setting-sources project,local`): 42 of 45
  solved in both arms, mean 186k against 202k, median 149k against 212k (before: mean 317k). `/context`
  still counts the deferred schemas; the request's own usage is the measure.
- **Measured on Haiku 5.5** (2026-11-19, fabric arm, tasks 02, 04, 08, 12 and 14, 3 runs each, raw rows
  in `notes/bench/results-haiku-*.jsonl`): the old guidance passed 15/15 at 363k mean tokens; the
  program guidance (#21) 15/15 at 325k; that guidance with `fabricOnly` 15/15 at 277k, with 6.67
  requests against 8.07 and 50 s against 65 s. The guidance alone moved work from programs to direct
  Bash (38 programs and 56 Bash calls, against 77 and 19), so its saving is real but not where it was
  aimed; `fabricOnly` makes programs the path. No native arm ran, so this is not a step 6 result.

## Out of scope

What Claude Code gives a plugin no surface for: custom model providers and Jev auth, cache
warming leases, per-request context projection (Pi's `context` event), and Pi's session tree.
Pi's TUI is not ported; UI is rebuilt on mod elements. Revisit a gap when Claude Code adds the
surface.
