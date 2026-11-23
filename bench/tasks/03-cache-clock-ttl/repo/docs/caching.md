# Cache counters

`stats()` returns the numbers the metrics service exports:

| counter | meaning |
| --- | --- |
| `hits` | `get` found a live entry |
| `misses` | `get` found no entry at all |
| `expirations` | `get` found an entry whose TTL ran out |
| `size` | live entries, expired ones excluded |

`sweep()` drops expired entries eagerly and returns how many it removed. It does
not change the counters above.

All of these read time from the `Clock` the cache was constructed with, so a
test can advance a `fixedClock` and see the same answers a real clock would give.
