# Routes

Registered in this order by `src/app.ts` and `src/routes/`:

| Method | Pattern | File |
| --- | --- | --- |
| GET | `/legacy/*` | `src/middleware/legacyRedirect.ts` |
| GET | `/health` | `src/routes/health.ts` |
| GET | `/api/products` | `src/routes/catalog.ts` |
| GET | `/api/products/:id` | `src/routes/catalog.ts` |
| GET | `/api/*` | `src/middleware/notFound.ts` |
| GET | `/api/orders` | `src/routes/orders.ts` |
| GET | `/api/orders/:id` | `src/routes/orders.ts` |
| POST | `/api/orders` | `src/routes/orders.ts` |
| GET | `/api/cart` | `src/routes/cart.ts` |

Matching is first-registered-wins; a trailing `*` matches one or more deeper
segments.
