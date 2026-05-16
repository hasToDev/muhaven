---
title: Hosted Checkout — overview
description: One-click pay links for issuers to sell to non-customer buyers.
---

# Hosted Checkout

`muhaven.app/pay` is MuHaven's **hosted checkout** surface. It lets an issuer mint a one-off pay link, share it (Telegram, email, Twitter DM), and have a non-customer buyer pay with a passkey — no MuHaven account required ahead of time.

It's the only surface designed for **users who don't yet have a MuHaven wallet**. The first-time buyer's MuHaven wallet is provisioned via `@zerodev/passkey-validator` at checkout; returning buyers reuse it.

## The link

A checkout URL looks like:

```
https://muhaven.app/pay/c/01HMTV9X.../#k=AbCdEfGhIjKlMnOpQrStUvWxYz123456
```

Two parts:

- **Path** (`/pay/c/<ulid>/`) — the public session ID. The server uses this to look up the *ciphertext* of the session payload.
- **Fragment** (`#k=...`) — the 32-byte AES-256-GCM decryption key. Encoded as base64url.

The **fragment is never sent in `Referer` headers**, so the server holds ciphertext that's useless without the key. This is the [Stripe Checkout pattern](https://stripe.com/docs/payments/checkout) adapted for a privacy-preserving flow. See [URL fragment key (privacy)](/checkout/fragment-key) for the full security argument.

## What's in a checkout session

The encrypted payload contains:

- Issuer label ("You are paying [Issuer Verified]" — Stripe pattern).
- Token symbol and address.
- Amount (in mhUSDC, 6-decimal).
- Webhook URL (if the issuer wants real-time notifications).
- TTL (default 30 minutes from creation).

The buyer-facing page renders this in cleartext after the fragment-key decrypts the payload **client-side**.

## When to use Hosted Checkout

| Question | If yes → Hosted Checkout |
|---|---|
| Are you an issuer minting a one-off pay link? | ✅ |
| Does your buyer not have a MuHaven account yet? | ✅ |
| Do you need a real-time settlement notification? | ✅ (webhooks + SSE) |
| Do you need recurring billing? | ❌ Not supported — each checkout is one-shot. |
| Do you want the buyer's strategy + identity to stay private from MuHaven's operators? | ✅ (fragment-key keeps payload opaque to operator) |
| Do you want to drive checkout from an LLM workflow? | ✅ — HavenBot's `create_checkout` tool mints the URL |

## End-to-end flow

```
┌─ Issuer ──────────────────────────────────────────────────┐
│ 1. Calls HavenBot "Create a checkout for 500 mhUSDC of    │
│    <TOKEN> expiring in 24 hours"                           │
│ 2. HavenBot returns: https://muhaven.app/pay/c/.../#k=... │
│ 3. Issuer shares the link (Telegram / email / DM)         │
└────────────────────────────────────────────────────────────┘
                            │
                            │ shares
                            ▼
┌─ Buyer ───────────────────────────────────────────────────┐
│ 4. Opens the link in any modern browser                   │
│ 5. /pay page decrypts the payload with the fragment key   │
│    client-side; renders "You are paying [Issuer Verified] │
│    500 mhUSDC of <TOKEN>"                                  │
│ 6a. (First-time) Buyer creates a passkey at checkout      │
│     → MuHaven wallet deploys                              │
│ 6b. (Returning) Buyer signs in with existing passkey      │
│ 7. Buyer confirms; passkey signs the buy UserOp           │
│ 8. SSE channel streams settlement progress                │
│ 9. Buyer sees "Settled" + Arbiscan link                   │
└────────────────────────────────────────────────────────────┘
                            │
                            │ SSE / webhook
                            ▼
┌─ Issuer ──────────────────────────────────────────────────┐
│ 10. HavenBot says "✅ checkout chk_01HMTV... paid"         │
│ 11. (Optional) Webhook fires to issuer's URL              │
└────────────────────────────────────────────────────────────┘
```

## What's available

- Backend `checkout_sessions` table + REST routes under `/api/v1/checkout/*`.
- AES-256-GCM enc_payload with key in URL fragment.
- Stripe-style `MuHaven-Signature: t=,v1=` HMAC-SHA256 webhook signing with 5-min replay window.
- In-process SSE channel with terminal-state auto-close + 25s heartbeat.
- SSRF guard on outbound webhook URLs (blocks RFC1918 + 169.254 + IPv6 ULA + link-local).
- Pluggable `FundingProvider` abstraction in `apps/checkout-pay/` Vite project — `FaucetRedirectProvider` for testnet; provider slots for on-ramp services on production.
- Passkey ceremony for first-time buyers (RP-ID pinned to `muhaven.app`) via the ZeroDev-powered MuHaven wallet.

## Where next

<div class="mh-card-grid">
  <a class="mh-card" href="/checkout/for-issuers">
    <h3>For issuers</h3>
    <p>Create a checkout link via HavenBot. Webhook setup. Real-time monitoring.</p>
  </a>
  <a class="mh-card" href="/checkout/for-buyers">
    <h3>For buyers</h3>
    <p>What the buyer sees, the passkey ceremony, the SSE settlement channel.</p>
  </a>
  <a class="mh-card" href="/checkout/fragment-key">
    <h3>URL fragment key</h3>
    <p>Why the key lives in the URL fragment and what that protects against.</p>
  </a>
  <a class="mh-card" href="/checkout/webhooks">
    <h3>Webhooks & receipts</h3>
    <p>Signed webhooks, replay window, idempotency, SSRF guard.</p>
  </a>
</div>
