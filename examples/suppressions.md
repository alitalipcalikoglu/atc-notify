# Suppressions, bounces and unsubscribes

An address on the suppression list gets no mail from this service. It gets there four ways: a hard bounce or a complaint (at once), repeated soft bounces (`SOFT_BOUNCE_LIMIT`, default 3), a one-click unsubscribe, or an operator. Managing the list needs an `admin` key (`id:secret:admin` in `NOTIFY_API_KEYS`).

## Sending to a suppressed address

```bash
curl -s -X POST $NOTIFY/v1/messages -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"channel":"email","template":"generic","to":["ok@example.com","gone@example.com"],"data":{"appName":"Shop","subject":"Hi","title":"Hello","paragraphs":["…"]}}'
```

`202`, with the suppressed address left out and named:

```json
{ "id": "…", "status": "queued", "to": ["ok@example.com"], "suppressed": ["gone@example.com"], "…": "…" }
```

When no `to` address is left: `422 RECIPIENTS_SUPPRESSED` with `details: [{ "email": "gone@example.com" }]`. A message accepted before its address was suppressed is checked again right before sending and ends `failed` with `every recipient is suppressed`.

## Transactional mail

A user who unsubscribed from a newsletter, or whose provider filed a complaint, must still be able to reset a password or confirm an address. Send such mail with `"transactional": true`:

```bash
curl -s -X POST $NOTIFY/v1/messages -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"channel":"email","template":"password-reset","to":["gone@example.com"],"transactional":true,"data":{…}}'
```

| Suppression reason | Ordinary mail | Transactional mail |
|---|---|---|
| `unsubscribe`, `complaint` | dropped | sent |
| `hard_bounce`, `soft_bounce`, `manual` | dropped | dropped |

Only `readwrite` and `admin` keys may set the flag (`403 FORBIDDEN` for others); it cannot be combined with `unsubscribe`. atc-auth sets it on every mail it sends, the console on the messages it sends by hand.

## Managing the list

```bash
curl -s "$NOTIFY/v1/suppressions?q=example.com&limit=50" -H "Authorization: Bearer $ADMIN"
curl -s -X POST $NOTIFY/v1/suppressions -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"email":"gone@example.com","note":"asked by phone"}'
curl -s -X DELETE $NOTIFY/v1/suppressions/gone%40example.com -H "Authorization: Bearer $ADMIN"
```

The list answer carries `counts` per reason. The admin console has the same under Notify, "Suppressions".

## Bounce and complaint reports

From a relay holding an admin key:

```bash
curl -s -X POST $NOTIFY/v1/suppressions/events -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"events":[{"type":"bounce","email":"nobody@example.com","detail":"550 5.1.1 user unknown"},{"type":"bounce","email":"full@example.com","permanent":false},{"type":"complaint","email":"angry@example.com"}]}'
```

```json
{ "received": 3, "suppressed": 2 }
```

Or straight from the provider (or a relay without a key) through the signed hook. Set `BOUNCE_WEBHOOK_SECRET` (32+ characters) and sign `<unix seconds>.<raw body>`:

```bash
BODY='{"events":[{"type":"bounce","email":"nobody@example.com"}]}'
T=$(date +%s)
SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$BOUNCE_WEBHOOK_SECRET" -hex | sed 's/^.* //')
curl -s -X POST $NOTIFY/v1/hooks/bounces -H 'Content-Type: application/json' -H "X-Notify-Signature: t=$T,v1=$SIG" -d "$BODY"
```

`401 INVALID_SIGNATURE` for a wrong signature or one older than five minutes; `404` while no secret is set.

## One-click unsubscribe

For mail people can opt out of (newsletters, digests), not for account mail. Set `PUBLIC_BASE_URL` (where this service is reachable from the internet) and `UNSUBSCRIBE_SECRET`, then send with `"unsubscribe": true` to exactly one address:

```json
{ "channel": "email", "template": "generic", "to": ["reader@example.com"], "unsubscribe": true, "data": { "…": "…" } }
```

The mail carries `List-Unsubscribe: <https://notify.example.com/v1/unsubscribe/…>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, so mail clients show their own unsubscribe button. Their POST suppresses the address with reason `unsubscribe`; opening the link in a browser shows a page with a button first (a GET never unsubscribes, so link scanners cannot).

## Pitfalls

- Removing an address from the list does not reset the provider's own suppression list; check both.
- The hook takes one neutral format. SES, SendGrid or Postmark events need a few lines of translation in a relay.
- `unsubscribe: true` needs one recipient: one header cannot unsubscribe several people.
