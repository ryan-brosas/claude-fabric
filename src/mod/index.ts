import type { Register } from "claude-code";
import { compact } from "../compaction/compact.ts";
import { bridgePathProblem, bridgePaths, type BridgeAnswer, type BridgePaths } from "../bridge/contract.ts";
import {
  answerOf,
  emptyState,
  failureOf,
  jobOf,
  markedPosted,
  notedSecret,
  notedTools,
  publishPlan,
  requestOf,
  retryDelay,
} from "./bridge.ts";

// The in-process half of the plugin: compaction, and the loop that lets a program's
// mcp.<server>.<tool>() reach Claude Code's own MCP connections.
//
// The hooks compiler refuses a `$` that is bound, passed, spread, returned or read: `$` is always
// spelled `$.noun.method(...)` at the call site, inside a hook body. So every `$` call is literal
// here, and src/mod/bridge.ts holds the plain-data helpers these bodies call. test/mod/imports.test.ts
// refuses the mistake again.
export const register: Register = (on) => {
  // Between hook bodies: the catalog to publish, and this session's socket once it is known.
  let state = emptyState();
  let socket: BridgePaths | undefined;

  // Compaction is Fabric's deterministic summary: no model call, so there is nothing to
  // precompute, and a compactor that throws falls back to core's own.
  on("session.compact", ($, e, next) => {
    if (e.trigger === "precompute") return { skip: "fabric: compaction is deterministic; nothing to precompute" };
    return compact(e.messages, { instructions: e.instructions });
  }).catch(($, e, next) => next(e));

  // Started and not awaited: the loop runs outside this hook's 10 s budget and keeps polling
  // between hooks. It reads the plugin's data folder and the session's socket once, then
  // long-polls; a job is answered beside the loop, so a slow MCP server does not hold the next call.
  on("session.start", ($, e, next) => {
    void (async () => {
      const say = (text: string): void => {
        try {
          $.ui.log("fabric: " + text);
        } catch {
          // A UI that is not there costs the line, not the loop.
        }
      };
      const wait = (ms: number): Promise<void> =>
        new Promise<void>((resolve) => { $.clock.after(ms, () => resolve()); });

      // The mod has no env of its own; hookEnv names this plugin's data folder (it makes it).
      const data = await $.process.hookEnv()
        .then((env) => env.CLAUDE_PLUGIN_DATA ?? "")
        .catch(() => "");
      if (data === "") {
        say("CLAUDE_PLUGIN_DATA is empty, so mcp.<server>.<tool>() cannot reach this session's MCP servers");
        return;
      }
      const sessionId = await $.session.id().catch(() => "");
      if (sessionId === "") {
        say("the session has no id, so the bridge has no socket name");
        return;
      }
      const paths = bridgePaths(data, sessionId);
      const problem = bridgePathProblem(paths);
      if (problem !== undefined) {
        say(problem);
        return;
      }
      socket = paths;

      let failures = 0;
      for (;;) {
        try {
          const secret = (await $.fs.read(paths.secret)).trim();
          if (secret === "") throw new Error("the bridge secret is empty");
          state = notedSecret(state, secret);
          const plan = publishPlan(state);
          if (plan !== undefined) {
            const post = requestOf(plan.path, secret, plan.body, paths);
            if ((await $.http.fetch(post.url, post.init)).ok) state = markedPosted(state, plan.version);
          }
          const poll = requestOf("/next", secret, {}, paths);
          const response = await $.http.fetch(poll.url, poll.init);
          if (!response.ok) throw new Error("the bridge answered " + response.status);
          failures = 0;
          const job = jobOf(response.text);
          if (job !== undefined) {
            void (async () => {
              let answer: BridgeAnswer;
              try {
                answer = answerOf(job.id, await $.mcp.call(job.server, job.tool, job.args));
              } catch (error) {
                answer = failureOf(job.id, error);
              }
              const post = requestOf("/answer", secret, answer, paths);
              await $.http.fetch(post.url, post.init).catch(() => undefined);
            })();
          }
        } catch {
          // The socket is not up yet, is gone, or the secret is stale: wait, then ask again. The
          // loop never ends the hooks worker.
          failures++;
          await wait(retryDelay(failures)).catch(() => undefined);
        }
      }
    })();
    return next(e);
  }).catch(($, e, next) => next(e));

  // The session's tool pool is the catalog a program's mcp calls are checked against, and the
  // engine raises this event again when that pool changes. The answer goes back untouched.
  on("tool.list", async ($, e, next) => {
    const listed = await next(e);
    if (listed.value === undefined) return listed;
    state = notedTools(state, listed.value);
    // Published here as well as by the loop: the loop may be parked in its long poll, and a program
    // that runs meanwhile would otherwise find no catalog.
    if (socket !== undefined) {
      const secret = (await $.fs.read(socket.secret).catch(() => "")).trim();
      if (secret !== "") {
        state = notedSecret(state, secret);
        const plan = publishPlan(state);
        if (plan !== undefined) {
          const post = requestOf(plan.path, secret, plan.body, socket);
          const sent = await $.http.fetch(post.url, post.init).catch(() => undefined);
          if (sent !== undefined && sent.ok) state = markedPosted(state, plan.version);
        }
      }
    }
    return listed;
  }).catch(($, e, next) => next(e));
};
