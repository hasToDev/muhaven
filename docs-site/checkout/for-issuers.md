---
title: Checkout — for issuers
description: Mint a checkout link, share it, monitor it.
---

# Hosted Checkout — for issuers

You're an approved issuer and you want to sell some of your RWA token to a specific buyer (or batch of buyers) without onboarding each one into your KYC whitelist. Hosted Checkout is the surface for that.

The end-to-end loop:

1. Mint a link via HavenBot.
2. Share it.
3. Watch the SSE channel (or your webhook URL) for the settlement notification.
4. (Optionally) cancel an unredeemed link.

## Step 1 — Mint the link

In HavenBot, ask:

> Create a checkout for 500 mhUSDC of TBILL1 expiring in 24 hours.

HavenBot calls the `create_checkout` tool (an issuer-only tool that lives in HavenBot's `muhaven_*` namespace). The ConfirmModal renders a preview:

```
Create checkout link
─────────────────────
  Token:          TBILL1
  Amount:         500 mhUSDC
  Expires:        in 24 hours (2026-05-17 11:42 UTC)
  Webhook:        (none)
  Buyer:          (any holder of a valid passkey)
  Label:          (auto: "TBILL1 — 500 mhUSDC")

  [Cancel]                              [Confirm]
```

Confirm with your passkey. HavenBot replies:

```
✅ Created checkout chk_01HMTV9X...

🔗 Link: https://muhaven.app/pay/c/01HMTV9X.../#k=AbCdEfGhIjKlMnOpQrStUvWxYz123456

Share this link with your buyer. The fragment after # is the
decryption key — if you share the link with the # part stripped,
the buyer will get a "Session not found" error.
```

::: tip Don't lose the fragment
Telegram, Twitter, and Slack reliably preserve URL fragments when pasted as links. Markdown link syntax (`[text](url)`) on platforms that mangle fragments may strip the `#k=...` part. If you're sharing across a known fragment-stripping channel, share the URL as plain text instead of a hyperlink.
:::

## Step 2 — Optional webhook setup

If you want real-time programmatic notifications (instead of polling), set up a webhook:

> Create a checkout for 1000 mhUSDC of GOLD1 with webhook https://my.api/cb expiring in 12 hours.

HavenBot's preview adds:

```
  Webhook:        https://my.api/cb (will be signed with whsec_...)
```

Confirm with your passkey. The backend generates a unique `whsec_<32-hex>` per checkout session, stored against the session row. Every webhook delivery to `https://my.api/cb` carries:

- `Content-Type: application/json`
- `MuHaven-Signature: t=<unix>,v1=<HMAC-SHA256(t.body, whsec_...)>`
- `Idempotency-Key: <ulid>` for dedupe

See [Webhooks & receipts](/checkout/webhooks) for the verifier code and replay-window semantics.

## Step 3 — Watch the settlement

Three ways to know when the buyer paid:

### A. HavenBot SSE notification

HavenBot subscribes to your issuer-side SSE channel when you mint a checkout. As soon as the buyer's UserOp settles, HavenBot says:

```
✅ chk_01HMTV9X... paid
   Buyer: 0xabc...123 (first-time MuHaven kernel)
   Amount: 500 mhUSDC
   Token: TBILL1
   Settled in tx: 0xdef...
   View on Arbiscan
```

### B. Your webhook URL

If you registered a webhook, your endpoint receives a POST:

```json
{
  "id": "evt_01HMTV...",
  "type": "checkout.session.paid",
  "data": {
    "session_id": "chk_01HMTV9X...",
    "issuer_user_id": "usr_...",
    "token": "TBILL1",
    "amount_usd6": 500000000,
    "buyer_wallet": "0xabc...123",
    "settled_at": "2026-05-16T11:43:21Z",
    "tx_hash": "0xdef..."
  }
}
```

Verify the signature, then act.

### C. Polling

Ask HavenBot:

> What's the status of checkout chk_01HMTV9X...?

Replies with the current status: `pending` / `paid` / `expired` / `cancelled`.

## Step 4 — Cancel an unredeemed link

If you change your mind before the buyer pays:

> Cancel checkout chk_01HMTV9X...

HavenBot opens a ConfirmModal; confirm with your passkey. The backend flips the session row to `cancelled` and stops accepting payment attempts. If the buyer's link is still in their messages, they'll get a "Session cancelled" page on click.

You **can't** cancel a paid session — it's already on-chain.

## Listing your checkout sessions

> Show me my recent checkouts.

HavenBot calls the `list_checkouts` tool and renders a table:

```
ID                    Token   Amount   Status      Created             Expires
chk_01HMTV9X...       TBILL1  500.00   paid        2026-05-15 11:42    -
chk_01HMTV8Y...       GOLD1   1000.00  pending     2026-05-16 09:14    2026-05-16 21:14
chk_01HMTV7Z...       OCEAN   250.00   expired     2026-05-14 16:00    2026-05-15 04:00
chk_01HMTV6W...       TBILL1  750.00   cancelled   2026-05-13 12:00    -
```

You can filter:

> Show me my checkouts that are still pending.

Or:

> Show me checkouts paid in the last week.

## Composite indexes for fast queries

The `checkout_sessions` table has a composite index on `(issuer_user_id, status, created_at)` so the dashboard's list view stays fast even at scale. You don't need to do anything special — just know that querying by issuer + status returns in <10ms even with millions of rows.

## Privacy properties

- **The fragment key never reaches our server.** Your operator can't decrypt the session payload — they only have ciphertext.
- **The buyer's wallet address** is logged in the audit row only **after** payment (i.e., the operator learns who paid once payment settles, but the buyer's identity isn't exposed pre-payment).
- **The webhook secret** (`whsec_...`) is per-session and never reused.
- **The audit log** records `checkout_created` + `checkout_paid` + `checkout_expired` + `checkout_cancelled` — full forensic trail.

## What hosted checkout doesn't do

- **Recurring billing.** Each checkout is one-shot. Subscriptions are Wave 5+.
- **Buy-and-claim in one flow.** Buyer-side flows always settle in the buy step; claim is a separate user action on their dashboard.
- **Refunds.** The on-chain Subscription contract doesn't support refunds. If you over-charged, mint a yield distribution back to the buyer.
- **Per-buyer KYC enforcement.** The KYC whitelist is at the token level. If your token is on KYC mode and the buyer isn't whitelisted, the buy reverts. Wave 5 may add a "whitelist-on-payment" preset to the checkout flow.

## Where next

- [For buyers](/checkout/for-buyers) — what your buyer experiences.
- [URL fragment key](/checkout/fragment-key) — the privacy property in detail.
- [Webhooks & receipts](/checkout/webhooks) — signing, replay window, idempotency.
- [Troubleshooting](/checkout/troubleshooting) — common issuer-side issues.
