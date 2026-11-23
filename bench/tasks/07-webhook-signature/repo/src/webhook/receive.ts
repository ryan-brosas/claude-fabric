import { handlePing } from "../handlers/ping";
import type { Queue } from "../queue";

export interface ReceiveDeps {
  secret: string;
  toleranceSeconds: number;
  queue: Queue;
  /** Current time in unix seconds; tests inject it. */
  now?: () => number;
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

// TODO: check the x-relay-signature header once src/webhook/verify.ts lands.
export function receiveWebhook(
  headers: Headers,
  rawBody: string,
  deps: ReceiveDeps,
): WebhookResult {
  const topic = headers.get("x-relay-topic") ?? "unknown";
  let payload: unknown = null;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = null;
  }

  if (topic === "ping") handlePing(payload);

  const nowSeconds = deps.now?.() ?? Math.floor(Date.now() / 1000);
  deps.queue.push({
    topic,
    payload,
    receivedAt: new Date(nowSeconds * 1000).toISOString(),
  });

  return { status: 202, body: { accepted: true } };
}
