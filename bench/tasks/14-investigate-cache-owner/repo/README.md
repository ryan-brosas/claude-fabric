# leaklab

Small service used to reproduce a memory complaint: two caches, a few
services that use them, and a couple of background jobs.

- `src/cache/` holds the caches.
- `src/services/` holds the request-time readers.
- `src/jobs/` holds the background refreshers.

## Commands

- `bun test`

`docs/caching.md` says which cache each module is expected to use.
