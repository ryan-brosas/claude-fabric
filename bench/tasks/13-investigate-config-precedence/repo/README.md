# layered-conf

Layered configuration resolver: defaults, an optional JSON file, the
environment, then command line flags, with an optional named profile overlay.

```ts
import { resolveConfig } from "./src/index.ts";

const { config, profile } = resolveConfig({ argv: ["--port=6000"], env: process.env });
```

`src/sources/` has one module per source, `src/resolve.ts` merges them in order,
and `src/schema.ts` lists the keys the resolver knows.

## Commands

- `bun test`

`docs/configuration.md` describes the precedence.
