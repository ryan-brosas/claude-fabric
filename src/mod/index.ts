import type { Register } from "claude-code";
import { compact } from "../compaction/compact.ts";
import { boundSecret, bridgePathProblem, bridgePaths, isBuiltinTool, type BridgeAnswer, type BridgePaths } from "../bridge/contract.ts";
import { FABRIC_EXEC_TOOL, GUIDANCE_SECTION, GUIDANCE_TEXT } from "../guidance/guidance.ts";
import {
  answerOf,
  emptyState,
  failureOf,
  jobOf,
  markedPosted,
  notedSecret,
  notedTools,
  publishPlan,
  receiptAccepted,
  refusedBuiltin,
  requestOf,
  retryDelay,
} from "./bridge.ts";
import { compactDeferred } from "./deferred.ts";
import { fabricOnly, offered } from "./fabric-only.ts";
import { OfferMemo } from "./verified/offer-memo.ts";

// The in-process half of the plugin: compaction, and the loop that lets a program's
// mcp.<server>.<tool>() reach Claude Code's own MCP connections and its WebSearch reach Claude
// Code's own search tool.
//
// The hooks compiler refuses a `$` that is bound, passed, spread, returned or read: `$` is always
// spelled `$.noun.method(...)` at the call site, inside a hook body. So every `$` call is literal
// here, and src/mod/bridge.ts holds the plain-data helpers these bodies call. test/mod/imports.test.ts
// refuses the mistake again.
export const register: Register = (on, options) => {
  // The person's `fabricOnly` option (plugin.json userConfig), read once at load.
  const programsOnly = fabricOnly(options);
  // Between hook bodies: the catalog to publish, and this session's socket once it is known.
  let state = emptyState();
  let socket: BridgePaths | undefined;
  // The session the socket belongs to: a secret file that names another session is not ours.
  let ownSession = "";
  // Whether the last tool list held fabric_exec: only then is the deferred list shortened.
  let fabricInPool = false;
  // fabricOnly's answer per loop and tool, fixed at the first ask (the one before the loop's first
  // request): a later ask is the model calling the tool, and it gets the answer the list showed.
  // proofs/offer-memo.ts holds the rule; a session's end drops every answer.
  const offers = new OfferMemo();

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
        say("CLAUDE_PLUGIN_DATA is empty, so mcp.<server>.<tool>() and WebSearch cannot reach this session's tools");
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
      ownSession = sessionId;

      let failures = 0;
      for (;;) {
        try {
          const secret = boundSecret(await $.fs.read(paths.secret), sessionId);
          if (secret === undefined) throw new Error("the bridge secret is empty or names another session");
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
              // Confirm the job before running it, and run it only if the server took the receipt:
              // a job whose call already failed at the receipt limit must not run late.
              const confirm = requestOf("/receipt", secret, { id: job.id }, paths);
              const confirmed = await $.http.fetch(confirm.url, confirm.init)
                .then((reply) => reply.ok && receiptAccepted(reply.text))
                .catch(() => false);
              if (!confirmed) return;
              let answer: BridgeAnswer;
              try {
                if (job.kind === "mcp") {
                  answer = answerOf(job.id, await $.mcp.call(job.server, job.tool, job.args));
                } else if (!isBuiltinTool(job.tool)) {
                  // The second wall: the host's allowlist decides which tool a job may name, and
                  // the mod refuses every other name before it reaches `$.tool.call`.
                  answer = failureOf(job.id, new Error(refusedBuiltin(job.tool)));
                } else {
                  answer = answerOf(job.id, await $.tool.call({ ...job.input, tool: job.tool }));
                }
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

  // One system prompt section, added last: when to reach for fabric_exec and what a program
  // keeps. Only a session whose pool offers the tool gets it, and a recompose that already holds
  // the section is left alone, so the text never lands twice.
  on("prompt.compose", async ($, e, next) => {
    const composed = await next(e);
    if (!e.tools.includes(FABRIC_EXEC_TOOL)) return composed;
    if (composed.sections.some((section) => section.id === GUIDANCE_SECTION)) return composed;
    return {
      sections: [...composed.sections, { id: GUIDANCE_SECTION, text: GUIDANCE_TEXT, scope: "session" as const }],
    };
  }).catch(($, e, next) => next(e));

  // An MCP server's tools sit behind ToolSearch by default, so the model never sees fabric_exec
  // until it searches, and the guidance names a tool it cannot call. Pin it into the prompt's list.
  on("tool.describe", async ($, e, next) => {
    const described = await next(e);
    if (e.tool !== FABRIC_EXEC_TOOL) return described;
    return { ...described, isDeferred: false };
  }).catch(($, e, next) => next(e));

  // With code mode off, Claude Code lists every deferred tool by name on each request. A session
  // that offers fabric_exec gets the list by server instead (src/mod/deferred.ts); the engine's
  // own prose is the only text rewritten, and only while fabric_exec is in the pool.
  on("prompt.attachment", { type: "deferred_tools_delta" }, async ($, e, next) => {
    const attached = await next(e);
    if (!fabricInPool || e.origin.kind !== "engine" || attached.text === null) return attached;
    return { text: compactDeferred(attached.text) };
  }).catch(($, e, next) => next(e));

  // The session's tool pool is the catalog a program's mcp calls are checked against, and the
  // engine raises this event again when that pool changes. The answer goes back untouched.
  on("tool.list", async ($, e, next) => {
    const listed = await next(e);
    if (listed.value === undefined) return listed;
    fabricInPool = listed.value.some((tool) => tool.name === FABRIC_EXEC_TOOL);
    state = notedTools(state, listed.value);
    // Published here as well as by the loop: the loop may be parked in its long poll, and a program
    // that runs meanwhile would otherwise find no catalog.
    if (socket !== undefined) {
      const secret = boundSecret(await $.fs.read(socket.secret).catch(() => ""), ownSession);
      if (secret !== undefined) {
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

  // With fabricOnly on, the main conversation's model is not offered the tools a program runs
  // (src/mod/fabric-only.ts). Agents keep them, and the pool is untouched, so $.tool.call too.
  // A loop whose first ask came before fabric_exec joined keeps its tools for its life: hiding
  // them later would refuse calls to a tool the model's list still shows.
  on("tool.offer", async ($, e, next) => {
    const answer = await next(e);
    if (!answer.isOffered || !programsOnly) return answer;
    const key = (e.agentId ?? "") + "\n" + e.tool;
    return { isOffered: offers.ask(key, () => offered(e.tool, { optionOn: programsOnly, agentId: e.agentId, fabricInPool })) };
  }).catch(($, e, next) => next(e));

  // /clear and a resume end a session and go on in the same process under a new id: the next
  // conversation's loops are asked afresh.
  on("session.end", ($, e, next) => {
    offers.clear();
    return next(e);
  }).catch(($, e, next) => next(e));
};
