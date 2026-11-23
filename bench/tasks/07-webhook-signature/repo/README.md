# hookrelay

Receives partner webhooks and hands them to our queue. Signing helpers live in
`src/sign.ts`; the receiver is `src/webhook/receive.ts`.

```ts
import { Queue, receiveWebhook } from "./src/index.ts";

const result = receiveWebhook(headers, rawBody, { secret, toleranceSeconds: 300, queue });
```

The wire format and the status codes we agreed on are in `docs/webhooks.md`.

## Commands

- `bun test`
