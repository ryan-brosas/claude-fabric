# Commands

| Command | Behavior |
| --- | --- |
| `add <task> [status] [durationMs]` | appends one run, prints `added <id>` |
| `list` | prints `id task status <duration>ms` per run |
| `help` | prints the usage text |

Statuses are `ok`, `failed` and `skipped`. The log path is `RUNLOG_FILE`,
default `./runlog.jsonl`; a missing file reads as an empty log.

Every command returns a process exit code: `0` on success, `2` for a usage
error.
