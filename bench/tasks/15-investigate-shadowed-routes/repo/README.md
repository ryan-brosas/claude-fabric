# shop-api

Route table for the storefront. `src/app.ts` registers the middleware and the
routers; `src/router.ts` matches paths in registration order.

```ts
import { createApp } from "./src/index.ts";

const app = createApp();
app.handle("GET", "/api/products");
```

## Commands

- `bun test`

`docs/routing.md` lists every endpoint.
