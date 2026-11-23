# gate-service

A tiny request gate: a middleware pipeline in front of a route handler.

```ts
import { createApp } from "./src/index.ts";

const app = createApp();
app.handle({ method: "GET", path: "/hello", clientIp: "1.2.3.4", headers: {} });
```

- `src/pipeline.ts` runs middleware in order until one answers.
- `src/middleware/` holds auth and logging.
- `src/app.ts` wires the default app; `src/config.ts` reads the environment.

`docs/gate.md` documents the middleware order and response shapes.

## Commands

- `bun test`
