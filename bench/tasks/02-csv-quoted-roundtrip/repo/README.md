# csvlite

Small CSV reader and writer used by the billing export job. No dependencies,
only Bun's built-in test runner.

```ts
import { readCsv, stringifyCsv } from "./src/index.ts";

const rows = readCsv('id,note\n1,"a, b"\n');
console.log(rows); // [ [ "id", "note" ], [ "1", "a, b" ] ]
console.log(stringifyCsv(rows));
```

## Behavior

- `parseCsv` turns text into raw rows. Quoted cells may contain the delimiter,
  newlines and doubled quotes (`""`).
- `readCsv` maps every cell through `normalizeField`: unquoted cells are trimmed
  by default, quoted cells keep their spacing.
- `stringifyCsv` must produce text that `readCsv` reads back as the same rows.
- `readObjects` turns the first row into keys.

## Docs

`docs/csv.md` has the field rules and the round-trip promise.

## Commands

- `bun test`
