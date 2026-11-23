# appbox

A small service skeleton: configuration in `src/config/`, a feature switch
helper, a logger, a database plan, a cache policy and a CLI.

```ts
import { createApp } from "./src/index.ts";

const app = createApp();
console.log(app.config.http.port);
```

Configuration comes from `src/config/defaults.ts`, then `APP_CONFIG` (a JSON
file), then the environment. `docs/configuration.md` has the details.

## Commands

- `bun test`
- `bun src/cli.ts --verbose`
