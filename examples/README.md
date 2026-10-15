# notify examples

Scenario-driven walkthroughs of every feature. All requests need `Authorization: Bearer <secret>` from `NOTIFY_API_KEYS` unless noted. Base URL below is `http://localhost:3001`.

| Example | Shows |
|---|---|
| [Send an email](send-email.md) | Queue a templated email, poll its delivery status |
| [Idempotent sends](idempotency.md) | `idempotencyKey` so retries never send twice |
| [Track, list and retry messages](message-status-and-retry.md) | `GET /v1/messages`, cursor paging, `lastError`, manual retry of failed messages |
| [Templates and their schemas](templates.md) | Listing templates, validation errors, adding a template |
| [Retries, failures and backoff](delivery-and-retries.md) | What counts as permanent vs. transient, backoff timing, crash recovery |
| [Suppressions, bounces and unsubscribes](suppressions.md) | Suppression list, bounce/complaint reports, the signed hook, one-click unsubscribe links |
| [Send quotas](quotas.md) | Per-key daily and per-recipient hourly limits, `429 QUOTA_EXCEEDED` |
| [API keys and roles](keys-and-roles.md) | read, readwrite and admin keys; seeing every sender's messages |
| [Operations](operations.md) | Health, readiness, metrics, environment, PM2 and Docker |
| [Audit events](audit-events.md) | Which write actions are forwarded to the audit service, event shape, configuration |

Set up once for the examples:

```bash
export NOTIFY=http://localhost:3001
export KEY=<your secret from NOTIFY_API_KEYS>
```
