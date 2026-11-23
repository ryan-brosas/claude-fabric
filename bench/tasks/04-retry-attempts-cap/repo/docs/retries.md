# Retry policy

| Field | Meaning |
| --- | --- |
| `maxAttempts` | total number of calls, including the first one |
| `baseDelayMs` | wait before the second attempt |
| `factor` | growth factor between waits |
| `maxDelayMs` | hard cap for one wait, jitter included |
| `jitter` | extra random share of `baseDelayMs`, in `[0, 1]` |

The measured wait for attempt `n` (1-based, after a failure) is
`min(baseDelayMs * factor^(n-1) + jitter, maxDelayMs)` with
`jitter = floor(random() * baseDelayMs * jitterShare)`.

No wait happens after the final attempt: with `maxAttempts: 3` a job that keeps
failing is called three times and sleeps twice.

`shouldRetry(error, attempt)` can stop the loop early; the original error is then
rethrown untouched.
