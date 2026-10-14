# Retries, failures and backoff

## Lifecycle

```
queued ──claim──▶ processing ──ok──▶ sent
                      │
                      └──error──▶ queued (next attempt later)   or   failed (permanent / attempts exhausted)
```

## Transient vs. permanent

| Channel | Retried | Failed immediately |
|---|---|---|
| email | network errors, SMTP 4xx, 552 | SMTP 5xx (bad mailbox, policy rejection) |

`lastError` keeps the reason, e.g. `421 4.7.0 try again later` (retried) or `550 5.1.1 no such user` (failed immediately).

## Backoff

Delay before attempt *n* is between half and full of `min(BACKOFF_BASE_MS × 2^(n-1), BACKOFF_CAP_MS)`.

With defaults (`BACKOFF_BASE_MS=5000`, `BACKOFF_CAP_MS=3600000`, `MAX_ATTEMPTS=8`):

| Attempt | Delay window |
|---|---|
| 1 | 2.5 s – 5 s |
| 2 | 5 s – 10 s |
| 3 | 10 s – 20 s |
| 4 | 20 s – 40 s |
| 5 | 40 s – 80 s |
| 6 | 80 s – 160 s |
| 7 | 160 s – 320 s |
| 8 | 320 s – 640 s → then `failed` |

An SMTP server outage of about 20 minutes is absorbed; longer needs a manual `retry`.

## Crash in the middle of a send

A message stays `processing` with `locked_until` set. If the process dies, the next start (and every minute afterwards) returns rows whose lock expired (`LOCK_TTL_MS`, default 120 s) to `queued`. The worst case is one duplicate email for that message; SMTP cannot dedupe it, but `X-Notify-Id` in the mail headers stays identical across retries for any downstream pipeline that wants to.

## Tuning

| Setting | Effect |
|---|---|
| `WORKER_CONCURRENCY` | Parallel deliveries per pass (default 5). Raise for high volume, mind SMTP provider limits. |
| `WORKER_POLL_MS` | Idle poll interval (default 500 ms). |
| `RETENTION_DAYS` | Sent/failed rows are deleted after this (default 30). |
