# Caching

Two caches exist:

- `LruCache` in `src/cache/lru.ts` is bounded by its `limit` (default 500).
- `memoize` in `src/cache/remember.ts` keeps every key it is given.

Request handlers should use `LruCache` with a limit that matches their data.
The background jobs already do.
