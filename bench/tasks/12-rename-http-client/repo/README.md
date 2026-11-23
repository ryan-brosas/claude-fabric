# fetchkit

HTTP helpers and the API clients our services share.

```ts
import { HttpClient, fetchJson } from "./src/index.ts";

const client = new HttpClient({ baseUrl: "https://api.example.test", token });
const users = await client.getJson("/users");
const health = await fetchJson("https://api.example.test/health");
```

- `src/http/` holds the client, the one-shot JSON fetch, headers and errors.
- `src/api/` has the typed clients for users, orders and search.
- `src/util/` has small retry and URL helpers.

Tests inject a fake `fetch`, so nothing touches the network.

## Commands

- `bun test`

`docs/api.md` has the exported surface.
