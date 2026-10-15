# Send quotas

Two counters bound how much one key can send, which matters most when a key leaks:

| Setting | Counts | Default |
|---|---|---|
| `DAILY_SEND_LIMIT` | recipients (to + cc + bcc) per key per UTC day | `0` (off) |
| `KEY_DAILY_LIMIT` | the same for named keys: `shop=5000,blog=200` | none |
| `RECIPIENT_HOURLY_LIMIT` | mails to one address per hour, over all keys | `20` |

Counted when a message is accepted. An idempotent replay (same `idempotencyKey`, same payload) does not count again. Suppressed addresses left out of a message do not count either.

Over a limit:

```json
{ "error": { "code": "QUOTA_EXCEEDED", "message": "this key may send to 5000 recipients per day", "details": [{ "scope": "key", "limit": 5000, "retryAfterSec": 31842 }] } }
```

Status `429` with `Retry-After` (seconds until the day or hour ends). `scope` is `key` or `recipient`; a recipient limit names the address in the message.

Pitfalls:

- A per-recipient limit protects people from mail loops; set it above what your own flows can send to one person in an hour (sign-up, verification resend, password reset).
- Limits are per service instance's database; there is one database per deployment, so they hold across API processes.
