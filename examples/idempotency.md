# Idempotent sends

Scenario: your backend retries failed HTTP calls. Without protection a retry sends the same email twice.

## Send with a key

```bash
curl -s -X POST $NOTIFY/v1/messages \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-42-receipt" \
  -d '{ "channel": "email", "template": "generic", "to": ["ali@example.com"],
        "data": { "appName": "Shop", "subject": "Receipt #42", "title": "Thanks for your order", "paragraphs": ["Order 42 is confirmed."] } }'
```

First call: `202`, `status: queued`.

## Retry the exact same call

Second call with the same `Idempotency-Key`: `200 OK`, `Idempotent-Replayed: true` and the **original** message (same `id`, current status). Nothing new is queued.

## Rules

- The key is unique per API key: `shop` and `blog` can both use `order-42-receipt` without colliding.
- 8 to 255 characters of `A-Z a-z 0-9 . _ : -` (`400 INVALID_IDEMPOTENCY_KEY` otherwise). Use something derived from your own record: `order-42-receipt`, `user-17-verify-3`.
- A replay must carry the same payload; the same key with another payload is `409 IDEMPOTENCY_MISMATCH`. Do not reuse a key for a different message.
- Keys live as long as the message row. Sent and failed rows are purged after `RETENTION_DAYS` (default 30); after that the key can be used again.

## Telling a replay from a first send

| Response | Meaning |
|---|---|
| `202 Accepted` | New message queued |
| `200 OK` | Replay; body is the existing message |
