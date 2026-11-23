# Inbound webhooks

Partner requests carry:

- `x-relay-topic`: the event topic.
- `x-relay-signature`: `t=<unix seconds>,v1=<hex>`, where the hex is the
  HMAC-SHA256 of the string `<t>.<raw body>` using our shared secret.

We agreed to reject a request when the timestamp is more than
`toleranceSeconds` away from our clock (either direction), or when the
signature does not match. A request we accept is answered `202 {"accepted":true}`
and pushed to the queue exactly once.

The receiver does not verify anything yet; `src/sign.ts` already has the HMAC
helper the outbound side uses.
