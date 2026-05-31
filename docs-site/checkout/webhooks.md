---
title: Checkout — webhooks & receipts
description: Stripe-style HMAC-signed webhooks with replay-window and SSRF guards.
---

::: warning 🚧 In development — not in the Testing Guide
This surface is still being hardened and isn't part of the [Testing Guide](/guide/). The page below describes the intended design. To evaluate MuHaven today, use [HavenBot](/havenbot/overview) or the [MCP server](/mcp/overview).
:::

# Webhooks & receipts

Checkout sessions can register a webhook URL at creation. When the buyer pays (or the session expires / is cancelled), MuHaven POSTs a signed JSON payload to your URL.

The implementation deliberately mirrors **Stripe's webhook contract** — same header name, same signature scheme, same replay-window semantics. If you have existing code that verifies Stripe webhooks, the verifier shape is identical.

## The request shape

```
POST https://your.api/checkout-callback
Content-Type: application/json
MuHaven-Signature: t=1684234567,v1=5a2c8b...
Idempotency-Key: 01HMTV9X...

{
  "id": "evt_01HMTV9X...",
  "type": "checkout.session.paid",
  "data": {
    "session_id": "chk_01HMTV9X...",
    "issuer_user_id": "usr_...",
    "token": "RWA1",
    "amount_usd6": 500000000,
    "buyer_wallet": "0xabc...",
    "settled_at": "2026-05-16T11:43:21Z",
    "tx_hash": "0xdef..."
  },
  "created_at": "2026-05-16T11:43:22Z"
}
```

## Event types

| `type` | When fired |
|---|---|
| `checkout.session.created` | Sent immediately after the checkout link is minted (if `notify_on_create` is true; default false). |
| `checkout.session.paid` | Fired when the buyer's on-chain settlement event is observed by the indexer. |
| `checkout.session.expired` | Fired when the session TTL elapses without a payment. |
| `checkout.session.cancelled` | Fired when the issuer cancels an unredeemed session. |

Each event has a unique `id` (`evt_<ulid>`); the `Idempotency-Key` header carries it so you can dedupe at your edge.

## Verifying the signature

The `MuHaven-Signature` header carries:

- `t=<unix>` — timestamp at which the signature was computed.
- `v1=<hex>` — HMAC-SHA256 of `${t}.${rawBody}` using your session's `whsec_...`.

Verifier in Node:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

function verifyMuHavenWebhook(
  rawBody: string,
  signatureHeader: string,
  whsec: string,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => p.split('=', 2)),
  )
  const t = Number(parts.t)
  const v1 = parts.v1
  if (!t || !v1) return false

  // 5-min replay window
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSeconds) return false

  const expected = createHmac('sha256', whsec)
    .update(`${t}.${rawBody}`)
    .digest('hex')

  // constant-time compare
  const expBuf = Buffer.from(expected, 'hex')
  const v1Buf = Buffer.from(v1, 'hex')
  if (expBuf.length !== v1Buf.length) return false
  return timingSafeEqual(expBuf, v1Buf)
}
```

Verify on **the raw body bytes** — don't `JSON.parse` first, since the HMAC was computed over the exact byte sequence MuHaven sent.

## Idempotency

The `Idempotency-Key` header is unique per event. If MuHaven retries a delivery (network blip, your endpoint returned 5xx), the retry carries the same key.

Your endpoint should:

1. Look up the key in your DB.
2. If you've already processed it, return `200 OK` without acting again.
3. If new, process + record the key + return `200 OK`.

This is the same shape as Stripe's idempotency-key pattern.

## Retry policy

MuHaven retries failed deliveries (5xx, network timeout) with exponential backoff:

- T+0s
- T+30s
- T+2m
- T+10m
- T+60m

After 5 failed attempts, the webhook is marked `failed` in the issuer's audit log. You can still poll the session status via the dashboard or HavenBot.

## SSRF guard

The webhook URL is **validated at registration time** to refuse:

- RFC1918 private ranges (10.x, 172.16-31.x, 192.168.x).
- Loopback (`127.0.0.1`, `localhost`, `0.0.0.0`).
- Link-local (`169.254.x` — AWS instance metadata).
- IPv6 ULA (`fc00::/7`) and link-local (`fe80::/10`).
- Bare host names that resolve to any of the above.

If you try to register `http://localhost:3000/cb` as a webhook, the create-checkout call rejects with `400 INVALID_WEBHOOK_URL`. Use a public HTTPS endpoint (e.g., a ngrok tunnel for dev, your real prod endpoint for prod).

## In-process SSE alternative

If you don't want to set up a webhook endpoint, you can subscribe to **Server-Sent Events** on the issuer-side SSE channel:

```ts
const eventSource = new EventSource(
  'https://api.muhaven.app/api/v1/checkout/events?token=<your-issuer-jwt>',
)
eventSource.addEventListener('checkout.session.paid', (e) => {
  const event = JSON.parse(e.data)
  // ...
})
```

The SSE channel auto-closes when the session reaches a terminal state (`paid` / `expired` / `cancelled`) and sends a 25-second heartbeat to keep the connection alive. It's **per-process** today — multi-replica deploys would need Redis pub/sub for fan-out.

## Webhook secret rotation

If your `whsec_...` is compromised:

1. Cancel any in-flight checkouts that registered the secret.
2. Mint new checkouts with a new webhook — each one gets a fresh `whsec_...`.

There's no "rotate the secret on an existing live session" path today; per-session secrets keep the blast radius bounded.

## What MuHaven doesn't do

- **It doesn't send webhooks for read-only events.** Only state transitions trigger a webhook.
- **It doesn't include the URL fragment key in webhook payloads.** The webhook is a server-to-server event; it doesn't need the key.
- **It doesn't follow redirects.** A webhook URL that returns a 301/302 fails delivery. Use the final URL.
- **It doesn't pin TLS to a specific CA.** Issuer-configurable cert pinning is not available today.

## Where next

- [For issuers](/checkout/for-issuers) — how to register a webhook at create time.
- [URL fragment key](/checkout/fragment-key) — the buyer-side privacy mechanic.
- [Troubleshooting](/checkout/troubleshooting) — webhook delivery issues.
