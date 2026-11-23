// Benchmark driver: runs each task in each arm in an interactive Claude Code session in tmux
// (native code mode runs only interactively), grades it with the task's hidden check, and
// appends one JSON line per run to notes/bench/results.jsonl.
// usage: bun bench/run.ts --arms plain,native,fabric --tasks 01-x,02-y|all --runs 1 [--parallel 3]
import { $ } from "bun";
import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createBillingNoticeHandler, promptStillInInput } from "./pane.ts";
import { decideResend } from "./resend-policy.ts";

const ROOT = join(import.meta.dir, "..");
const TASKS = process.env.BENCH_TASKS ?? join(ROOT, "bench/tasks");
const RUNS = process.env.BENCH_RUNS ?? join(ROOT, "notes/bench/bench-runs");
const RESULTS = process.env.BENCH_RESULTS ?? join(ROOT, "notes/bench/results.jsonl");
const MODEL = process.env.BENCH_MODEL ?? "claude-opus-5-5";
const CLAUDE = process.env.BENCH_CLAUDE ?? "claude";
const DEFAULT_CONFIG_DIR = join(process.env.HOME ?? "", ".claude");
const CONFIG_DIR = process.env.BENCH_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
const TURN_LIMIT_MS = 20 * 60_000;
const CONTINUE_BILLING_NOTICE = process.env.BENCH_CONTINUE_BILLING_NOTICE === "1";

type Arm = "plain" | "native" | "fabric";
const ARMS: Record<Arm, { env: Record<string, string>; args: string[] }> = {
  plain: { env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "0" }, args: [] },
  native: { env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1" }, args: [] },
  // Native code mode routes every tool through its REPL, MCP tools included, so the fabric arm
  // runs with it off: fabric_exec in place of the REPL, every other tool as in plain.
  fabric: { env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "0" }, args: ["--plugin-dir", process.env.BENCH_PLUGIN ?? ROOT] },
};

const flag = (name: string, fallback: string) => {
  const at = process.argv.indexOf("--" + name);
  return at === -1 ? fallback : process.argv[at + 1]!;
};
const arms = flag("arms", "plain,native,fabric").split(",") as Arm[];
const index = JSON.parse(readFileSync(join(TASKS, "index.json"), "utf8")) as { id: string }[];
const taskIds = flag("tasks", "all") === "all" ? index.map((t) => t.id) : flag("tasks", "").split(",");
const runs = Number(flag("runs", "1"));
const parallel = Number(flag("parallel", "3"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tokens(transcript: string) {
  const seen = new Map<string, any>();
  const tools: Record<string, number> = {};
  for (const line of readFileSync(transcript, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    const m = row.message;
    if (row.type !== "assistant" || !m?.usage || !m.id) continue;
    seen.set(m.id, m.usage);
    for (const block of m.content ?? []) if (block.type === "tool_use") tools[block.name] = (tools[block.name] ?? 0) + 1;
  }
  let input = 0, cacheWrite = 0, cacheRead = 0, output = 0;
  for (const u of seen.values()) {
    input += u.input_tokens ?? 0; cacheWrite += u.cache_creation_input_tokens ?? 0;
    cacheRead += u.cache_read_input_tokens ?? 0; output += u.output_tokens ?? 0;
  }
  return { calls: seen.size, input, cacheWrite, cacheRead, output, total: input + cacheWrite + cacheRead + output, tools };
}

async function runOne(arm: Arm, task: string, n: number) {
  const name = `${arm}-${task}-${n}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const dir = join(RUNS, name);
  const marker = join(RUNS, name + ".stop.json");
  const settings = join(RUNS, name + ".settings.json");
  mkdirSync(RUNS, { recursive: true });
  cpSync(join(TASKS, task, "repo"), dir, { recursive: true });
  // No git init: a repo root is its own project to Claude Code, which would ask for trust each run.
  writeFileSync(settings, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: `cat > '${marker}'` }] }] },
    ...(process.env.BENCH_FABRIC_ONLY === "1" ? { pluginConfigs: { "fabric@inline": { options: { fabricOnly: true } } } } : {}),
  }));
  const prompt = readFileSync(join(TASKS, task, "prompt.md"), "utf8").trim().replace(/\s*\n\s*/g, " ");
  const envs = Object.entries(ARMS[arm].env).map(([k, v]) => `${k}=${v}`).join(" ");
  // project,local only: the user's own settings (a globally enabled plugin, a code-mode env) must not
  // reach an arm. No Agent: a subagent ends the main turn early and the check grades unfinished work.
  // tmux runs a shell command; quote the executable as one argument, including paths with spaces.
  const executable = `'${CLAUDE.replace(/'/g, "'\\''")}'`;
  const cmd = `env ${envs} ${executable} --model ${MODEL} --setting-sources project,local --settings '${settings}' --disallowedTools Agent ${ARMS[arm].args.map((a) => `'${a}'`).join(" ")}`;
  const session = "fb-" + name;
  const started = Date.now();
  await $`tmux new-session -d -s ${session} -x 220 -y 50 -c ${dir} ${cmd}`.quiet();
  let result: Record<string, unknown> = { arm, task, n, name, model: MODEL, enterResends: 0,
    ...(CONTINUE_BILLING_NOTICE ? { billingNoticeContinues: 0 } : {}),
    ...(CLAUDE !== "claude" ? { claude: CLAUDE } : {}),
    ...(CONFIG_DIR !== DEFAULT_CONFIG_DIR ? { configDir: CONFIG_DIR } : {}) };
  try {
    for (let i = 0; ; i++) {
      await sleep(1000);
      const pane = await $`tmux capture-pane -p -t ${session}`.text();
      if (/❯/.test(pane) && /auto mode|bypass|accept edits|for shortcuts|plan mode/.test(pane)) break;
      if (i > 60) throw new Error("the session never showed its prompt");
    }
    // A person types after startup; MCP servers connect in the background, and a prompt sent at
    // once can reach the model before fabric_exec has joined (8 of 45 Haiku runs, 2026-11-19).
    await sleep(4000);
    await $`tmux send-keys -t ${session} -l ${prompt}`.quiet();
    await sleep(500);
    await $`tmux send-keys -t ${session} Enter`.quiet();
    // Resend only while the same prompt remains in the idle input box. A running turn
    // must never receive another Enter. Keep the count even if the run later errors.
    let enterResends = 0;
    for (;;) {
      await sleep(500);
      const pane = await $`tmux capture-pane -p -t ${session}`.text();
      if (!decideResend({ count: enterResends, pending: promptStillInInput(pane, prompt) }).resend) break;
      await $`tmux send-keys -t ${session} Enter`.quiet();
      result.enterResends = ++enterResends;
    }
    const billingNotice = CONTINUE_BILLING_NOTICE ? createBillingNoticeHandler(async () => {
      await $`tmux send-keys -t ${session} Enter`.quiet();
    }) : null;
    while (!existsSync(marker)) {
      if (Date.now() - started > TURN_LIMIT_MS) throw new Error("no Stop within the turn limit");
      await sleep(2000);
      // Poll only when opted in; recheck the stop marker and deadline before handling the capture.
      if (billingNotice && !existsSync(marker) && Date.now() - started <= TURN_LIMIT_MS) {
        const pane = await $`tmux capture-pane -p -t ${session}`.text();
        if (!existsSync(marker) && Date.now() - started <= TURN_LIMIT_MS) {
          await billingNotice.handle(pane);
          result.billingNoticeContinues = billingNotice.count;
        }
      }
    }
    const stop = JSON.parse(readFileSync(marker, "utf8"));
    const check = await $`bash ${join(TASKS, task, "check.sh")} ${dir}`.nothrow().quiet();
    // The hook supplies the encoded project directory and file name. Select the profile ourselves;
    // BENCH_CONFIG_DIR does not set CLAUDE_CONFIG_DIR for the launched executable.
    const transcript = join(CONFIG_DIR, "projects", basename(dirname(stop.transcript_path)), basename(stop.transcript_path));
    result = { ...result, sessionId: stop.session_id, seconds: Math.round((Date.now() - started) / 1000),
      pass: check.exitCode === 0, why: check.stdout.toString().trim().split("\n").pop(), ...tokens(transcript) };
  } catch (error) {
    result = { ...result, pass: false, error: String(error) };
  } finally {
    await $`tmux kill-session -t ${session}`.nothrow().quiet();
  }
  if (process.env.BENCH_RESULTS === undefined) mkdirSync(dirname(RESULTS), { recursive: true });
  appendFileSync(RESULTS, JSON.stringify(result) + "\n");
  console.log(JSON.stringify({ arm, task, n, pass: result.pass, total: result.total, error: result.error }));
  return result;
}

// Resume: a run already recorded without a driver error is not run again.
const done = new Set(existsSync(RESULTS)
  ? readFileSync(RESULTS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => r.error === undefined).map((r) => `${r.arm}/${r.task}/${r.n}`)
  : []);
const queue: [Arm, string, number][] = [];
for (let n = 1; n <= runs; n++) for (const task of taskIds) for (const arm of arms) if (!done.has(`${arm}/${task}/${n}`)) queue.push([arm, task, n]);
console.log(JSON.stringify({ queued: queue.length, skipped: done.size }));
await Promise.all(Array.from({ length: parallel }, async () => {
  for (let job = queue.shift(); job; job = queue.shift()) await runOne(...job);
}));
