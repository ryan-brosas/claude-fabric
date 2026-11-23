import { describe, expect, test } from "bun:test";
import { Queue } from "../../src/queue";
import { hmacHex } from "../../src/sign";
import { receiveWebhook } from "../../src/webhook/receive";

const SECRET = "s3cret";
const BODY = JSON.stringify({ id: "evt_1", at: "2026-01-01T00:00:00.000Z" });
const NOW = 1_800_000_000;

function signatureForT(t: number): string {
  return hmacHex(SECRET, `${t}.${BODY}`);
}

function headerValue(t: number, hex = signatureForT(t)): string {
  return `t=${t},v1=${hex}`;
}

function run(options: {
  header?: string | null;
  body?: string;
  now?: number;
  toleranceSeconds?: number;
} = {}) {
  const queue = new Queue();
  const headers = new Headers();
  if (options.header !== null) {
    headers.set("x-relay-signature", options.header ?? headerValue(NOW));
  }
  headers.set("x-relay-topic", "ping");
  const result = receiveWebhook(headers, options.body ?? BODY, {
    secret: SECRET,
    toleranceSeconds: options.toleranceSeconds ?? 300,
    queue,
    now: () => options.now ?? NOW,
  });
  return { result, queue };
}

describe("accepted requests", () => {
  test("a good signature is accepted and enqueued once", () => {
    const { result, queue } = run();
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ accepted: true });
    expect(queue.size).toBe(1);
    expect(queue.all()[0]?.topic).toBe("ping");
    expect(queue.all()[0]?.payload).toEqual({ id: "evt_1", at: "2026-01-01T00:00:00.000Z" });
  });

  test("the tolerance boundary is inclusive on both sides", () => {
    expect(run({ header: headerValue(NOW - 300) }).result.status).toBe(202);
    expect(run({ header: headerValue(NOW + 300) }).result.status).toBe(202);
  });

  test("the signature covers the timestamp as well as the body", () => {
    const staleTimestamp = NOW - 10;
    const { result } = run({ header: `t=${staleTimestamp},v1=${signatureForT(NOW)}` });
    expect(result.status).toBe(401);
    expect(result.body.error).toBe("bad_signature");
  });
});

describe("rejected requests leave the queue alone", () => {
  test("a missing header is malformed", () => {
    const { result, queue } = run({ header: null });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("malformed_signature");
    expect(queue.size).toBe(0);
  });

  test("a header without a timestamp is malformed", () => {
    const { result, queue } = run({ header: `v1=${signatureForT(NOW)}` });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("malformed_signature");
    expect(queue.size).toBe(0);
  });

  test("a non numeric timestamp is malformed", () => {
    const { result } = run({ header: "t=soon,v1=abcd" });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("malformed_signature");
  });

  test("a stale timestamp is out of range", () => {
    const { result, queue } = run({ header: headerValue(NOW - 301) });
    expect(result.status).toBe(401);
    expect(result.body.error).toBe("timestamp_out_of_range");
    expect(queue.size).toBe(0);
  });

  test("a timestamp too far in the future is out of range", () => {
    const { result, queue } = run({ header: headerValue(NOW + 301) });
    expect(result.status).toBe(401);
    expect(result.body.error).toBe("timestamp_out_of_range");
    expect(queue.size).toBe(0);
  });

  test("a wrong signature is rejected", () => {
    const { result, queue } = run({ header: headerValue(NOW, hmacHex(SECRET, BODY)) });
    expect(result.status).toBe(401);
    expect(result.body.error).toBe("bad_signature");
    expect(queue.size).toBe(0);
  });

  test("a signature for a different body is rejected", () => {
    const other = JSON.stringify({ id: "evt_2" });
    const { result, queue } = run({ header: headerValue(NOW, hmacHex(SECRET, `${NOW}.${other}`)) });
    expect(result.status).toBe(401);
    expect(result.body.error).toBe("bad_signature");
    expect(queue.size).toBe(0);
  });
});
