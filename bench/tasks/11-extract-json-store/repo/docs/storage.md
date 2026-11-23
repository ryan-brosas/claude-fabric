# Storage

Both services keep a JSON array in a file under `DUO_DATA_DIR`:

| File | Shape |
| --- | --- |
| `projects.json` | `Project[]` |
| `notes.json` | `Note[]` |

Paths are built by `src/storage/paths.ts`. A missing file reads as an empty
list; the services create the directory on the first write.

Each service currently parses and writes its own file, so the error handling
and the write path have drifted apart. A shared `src/storage/json-store.ts`
with `readJson`/`writeJson` would fix that, and `writeJson` should write a
temporary file in the same directory and rename it, so a crash cannot leave a
half-written JSON file behind.
