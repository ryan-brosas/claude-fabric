# Gate contract

Middleware order in `createApp()`: auth, then anything else the app adds, then
the route handler. The first middleware that returns a response wins.

| Situation | Status | Body |
| --- | --- | --- |
| missing or wrong bearer token | 401 | `{ "error": "unauthorized" }` |
| known route | 200 | route payload |
| unknown route | 404 | `{ "error": "not_found" }` |

`createApp({ auth, rateLimit, now })` takes the auth token, the rate limit
settings and a millisecond clock; anything omitted comes from `loadConfig()`
(`GATE_TOKEN`, `GATE_RATE_LIMIT`, `GATE_RATE_WINDOW_MS`).

The app does not limit request rates yet; the settings above are already read so
the limiter can use them.
