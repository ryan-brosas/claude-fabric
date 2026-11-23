# pulse-bus

A small in-process event bus used by our workers. Topics are dot separated paths
(`user.created`, `job.retry.failed`). Subscriptions may use wildcards:

- `*` matches exactly one segment.
- `#` matches the current level and everything below it, and must be the last
  segment of the pattern.

```ts
import { createBus } from "./src/index.ts";

const bus = createBus();
bus.on("user.*", (payload) => console.log("user event", payload));
await bus.emit("user.created", { id: "u_1" });
```

## Layout

- `src/topic.ts` splits and matches topic strings.
- `src/subscriber.ts` keeps the subscription registry and ordering.
- `src/emitter.ts` delivers payloads.
- `src/adapters/` holds the metric and log sinks our services plug in.

## Commands

- `bun test`
- `bun run src/demo.ts` prints a short delivery trace.

`docs/events.md` lists the topic shapes we publish in production.
