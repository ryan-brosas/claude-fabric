# Configuration

Sources are merged in this order, later wins:

1. `src/config/defaults.ts`
2. the JSON file named by `APP_CONFIG`
3. the environment

| env | key |
| --- | --- |
| `APP_PORT` | `http.port` |
| `APP_HOST` | `http.host` |
| `APP_DB_URL` | `db.url` |
| `APP_DB_POOL` | `db.poolSize` |
| `APP_FEATURE_BETA` | `features.beta` |
| `APP_FEATURE_AUDIT` | `features.auditLog` |

Booleans accept `1/0`, `true/false` and `yes/no`, case insensitive.
