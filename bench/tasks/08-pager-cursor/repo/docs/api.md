# Users endpoint

`GET /users`

| Query | Meaning |
| --- | --- |
| `limit` | page size, 1..100, default 20 |
| `cursor` | opaque value from the previous page's `nextCursor` |

Response:

```json
{ "items": [ { "id": "u_01", "email": "...", "name": "...", "createdAt": "..." } ], "nextCursor": null }
```

Items are ordered by `createdAt` ascending, ties broken by `id`. `nextCursor` is
`null` on the last page. Passing a cursor the service cannot read answers
`400 { "error": "invalid_cursor" }`, and a bad limit answers
`400 { "error": "invalid_limit" }`.

The cursor is opaque to clients: they only ever send back what `nextCursor`
gave them.
