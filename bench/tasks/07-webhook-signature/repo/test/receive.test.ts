import { describe, expect, test } from "bun:test";
import { Queue } from "../src/queue";
import { hmacHex } from "../src/sign";
import { receiveWebhook } from "../src/webhook/receive";

const SECRET = "test-secret";
const BODY = JSON.stringify({ id: "evt_1", at: "2026-01-01T00:00:00.000Z" });

function signedHeaders(nowSeconds: number, topic = "ping"): Headers {
  const signature = hmacHex(SECRET, `${nowSeconds}.${BODY}`);
  return new Headers({
    "x-relay-topic": topic,
    "x-relay-signature": `t=${nowSeconds},v1=${signature}`,
  });
}

describe("receiveWebhook", () => {
  test("accepts a signed ping and enqueues it", () => {
    const queue = new Queue();
    const now = Math.floor(Date.now() / 1000);
    const result = receiveWebhook(signedHeaders(now), BODY, {
      secret: SECRET,
      toleranceSeconds: 300,
      queue,
      now: () => now,
    });

    expect(result.status).toBe(202);
    expect(result.body).toEqual({ accepted: true });
    expect(queue.size).toBe(1);
    expect(queue.all()[0]?.topic).toBe("ping");
    expect(queue.all()[0]?.payload).toEqual({ id: "evt_1", at: "2026-01-01T00:00:00.000Z" });
  });

  test("records the receive time from the injected clock", () => {
    const queue = new Queue();
    const now = 1_800_000_000;
    receiveWebhook(signedHeaders(now), BODY, { secret: SECRET, toleranceSeconds: 300, queue, now: () => now });
    expect(queue.all()[0]?.receivedAt).toBe(new Date(now * 1000).toISOString());
  });
});
