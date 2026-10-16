# API keys and roles

```bash
NOTIFY_API_KEYS=shop:<64 hex>,panel:<64 hex>:read,console:<64 hex>:admin
```

| Role | Send, retry | List and fetch | Notes |
|---|---|---|---|
| `readwrite` (default, also for `id:secret` with no role) | yes, own messages | own messages | what every key had before roles existed |
| `read` | no, `403 FORBIDDEN` | own messages | a dashboard or an MCP client that must not send mail |
| `admin` | yes, any key's message | every key's messages | the operator console, which has to see what auth, status and export sent |

Messages are tied to the key that created them (`keyId` in every message). A normal key asking for another key's message gets `404`, an admin key gets it:

```bash
curl -s -H "Authorization: Bearer $ADMIN" "$NOTIFY/v1/messages?status=failed&limit=20"
```

`keyId` tells which service sent each one (`atc-auth`, `atc-status`, ...). The stack gives the console an `admin` key.

Pitfalls:
- An unknown role is a startup error (`must be read, readwrite or admin`).
- Idempotency keys stay scoped to the sending key; an admin key sending with the same `Idempotency-Key` as another key creates its own message.
- `/metrics` and the other probes are not role-gated.
