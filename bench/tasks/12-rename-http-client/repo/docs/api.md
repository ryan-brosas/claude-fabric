# Exported surface

| Export | Kind |
| --- | --- |
| `HttpClient` | class: `request`, `getJson`, `postJson` |
| `fetchJson` | one-shot JSON fetch |
| `HttpError` | error with `status` and `payload` |
| `withAuth` | header helper |
| `createUserApi`, `createSearchApi` | typed factories |
| `listOrders` | orders fetch |
| `retry`, `joinUrl`, `apiBaseUrl` | helpers |

Every function that talks to the network accepts an injected `fetch` so tests
stay offline.
