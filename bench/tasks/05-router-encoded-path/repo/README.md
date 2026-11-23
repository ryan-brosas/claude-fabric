# tiny-router

A small fetch-style router: routes live in `src/routes/`, middleware in
`src/middleware/`, and `createHandler()` returns a `Request => Response`
function you can hand to `Bun.serve`.

```ts
import { createHandler } from "./src/server.ts";

Bun.serve({ port: 3000, fetch: createHandler() });
```

Routes are matched in registration order. `:name` captures one path segment;
`*` matches one segment whatever it is. Paths are normalized before matching
(empty segments dropped, query string ignored, percent escapes decoded).

## Commands

- `bun test`

`docs/routing.md` lists the endpoints and the middleware order.
