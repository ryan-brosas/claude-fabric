# runlog

A tiny CLI that keeps a JSONL log of task runs. Every line is one run:
`{ id, task, status, durationMs, startedAt }`.

```sh
bun src/main.ts add deploy ok 1200
bun src/main.ts list
```

The log file comes from `RUNLOG_FILE` and falls back to `./runlog.jsonl`.

## Layout

- `src/cli.ts` parses the command line and dispatches.
- `src/commands/` holds one file per command.
- `src/log/` reads and writes the JSONL file.
- `src/format/` has the output helpers.

## Commands

- `bun test`
- `bun src/main.ts help`

`docs/commands.md` documents the existing commands.
