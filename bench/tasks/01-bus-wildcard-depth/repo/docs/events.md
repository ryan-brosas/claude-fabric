# Event topics

Published topics follow `<entity>.<action>` and deeper paths for lifecycle
stages. Consumers subscribe to the narrowest pattern they need.

| Topic | Payload |
| --- | --- |
| `user.created` | `{ id }` |
| `user.profile.updated` | `{ id, fields }` |
| `job.retry.started` | `{ attempt }` |
| `job.retry.failed` | `{ attempt, error }` |
| `billing.invoice.paid` | `{ invoiceId }` |

A subscription to `user.*` covers `user.created` and `user.deleted`, not
`user.profile.updated`; use `user.#` for the whole subtree.
