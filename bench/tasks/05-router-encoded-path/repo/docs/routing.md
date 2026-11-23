# Routes and middleware

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | liveness |
| GET | `/users` | all users |
| GET | `/users/:id` | one user, 404 when unknown |
| GET | `/files/:name` | one file name |
| GET | `/admin/stats` | needs `x-admin-token` |

Middleware runs in order: request logging, then the admin guard, then the
route handler. `createHandler()` catches `PathError` from the normalizer and
answers 400; unmatched routes answer 404.

The normalizer drops empty segments and the query string, decodes percent
escapes, and refuses `.`, `..` and null bytes in any segment.
