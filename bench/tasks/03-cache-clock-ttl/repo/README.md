# memo-cache

Small in-memory TTL cache. The cache takes a `Clock` so callers (and tests) can
control time.

```ts
import { Cache } from "./src/index.ts";

const cache = new Cache({ maxEntries: 500 });
cache.set("config:site", data, { ttl: 30_000 });
cache.get("config:site");
```

## Behavior

- `set` stores a value and starts its TTL. `ttl` defaults to infinite.
- `get` drops an entry once its TTL ran out and counts a miss.
- `has`, `size`, `ttl(key)` and `sweep()` all agree with `get` about expiry.
- `maxEntries` evicts the oldest entries first.

`docs/caching.md` lists the counters the metrics service reads.

## Commands

- `bun test`
