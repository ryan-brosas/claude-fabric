# pager-api

Read-only user listing service for the admin app. Storage is in memory for now
(`src/repo/memory.ts`), the listing logic is `src/service/list-users.ts`, and
the HTTP layer maps results in `src/http/`.

```ts
import { MemoryUserRepository, listUsers, seedUsers } from "./src/index.ts";

const repo = new MemoryUserRepository(seedUsers());
const page = listUsers(repo, { limit: 10 });
```

`docs/api.md` describes the endpoint contract.

## Commands

- `bun test`
