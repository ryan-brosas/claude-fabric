# retry-loop

Retry helper used by the job runners. Policies are described in
`docs/retries.md`; the defaults live in `src/policy.ts`.

```ts
import { retry } from "./src/index.ts";

const body = await retry((attempt) => callService(attempt), {
  maxAttempts: 4,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
});
```

## Commands

- `bun test`
