# duo-store

Two small services that keep their records as JSON files under
`DUO_DATA_DIR` (default `.data`):

- `src/services/projects.ts` creates and lists projects.
- `src/services/notes.ts` adds and lists notes for a project.

Paths come from `src/storage/paths.ts`. Tests and callers pass an `env` object so
the data directory can be a temporary one.

## Commands

- `bun test`
