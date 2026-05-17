---
title: OpenClaw — three confirmation tiers
description: The USD-amount classifier and per-tier confirmation flow.
---

# Three confirmation tiers

The OpenClaw + Telegram surface uses a **three-tier classifier** based on the USD amount of the proposed action. The classifier is pure, deterministic, and locked at the type level — investors cannot raise the boundaries above the hardcoded ceilings.

## The classifier

```ts
function classifyTier(amountUsd6: bigint): Tier {
  if (amountUsd6 <= 200_000_000n)    return 'inline'           // ≤ $200
  if (amountUsd6 <= 5_000_000_000n)  return 'mini_app_otp'     // $200 – $5K
  return 'passkey_deeplink'                                    // > $5K
}
```

Three brackets, two boundaries — both inclusive on the lower side:

| Amount (USD, 6-decimal mhUSDC) | Tier | Surface |
|---|---|---|
| ≤ $200 | **Inline** | Telegram inline keyboard button |
| $200 – $5,000 | **Mini-App OTP** | Telegram Mini App + 6-digit OTP |
| > $5,000 | **Passkey deeplink** | Dashboard `/agent/confirm` with WebAuthn |

The boundaries trace to **Reg BI Care Obligation** + **FINRA IM-2017-02** framing — small retail amounts (sub-$200) are presumed informed; mid-tier amounts need an additional friction step; institutional amounts (>$5K) need full passkey-bound authorization.

## Why the boundaries are hard-coded

Investors cannot raise the ceilings via `set_policy`. There is no "Telegram inline up to $1000" tier — the upper bound is a system invariant, not a per-user knob.

The lower bounds *could* be lowered (e.g., a user wants the Mini-App OTP for sub-$200) but the surface doesn't expose that knob today; everyone gets the same friction floor.

This is a deliberate choice that *prevents* investor self-coercion (e.g., "I'll just raise my inline tier to $5K so I can act faster") at the cost of some flexibility. The flexibility lives in the [HavenBot Confirm-per-action tier](/policy/tiered-autonomy) which can sign within a 1-hour session-key TTL without re-prompting.

## Tier 1 — Inline (≤$200)

**Flow:**

```
You → /buy 50 RWA1
Bot → renders inline-keyboard message:
        ┌─────────────────────────────────┐
        │ Buy 50 mhUSDC of RWA1?        │
        │                                  │
        │ [✅ Confirm]   [❌ Cancel]      │
        └─────────────────────────────────┘
You → tap Confirm
Bot → validates tap is from linked Telegram user_id
Bot → POSTs /api/v1/agent/openclaw/intent/confirm-inline
        body: { intentId, expectedChatId, expectedUserId, serviceSecret }
Backend → asserts row.tier === 'inline'
Backend → asserts row.chatId === expectedChatId
Backend → asserts row.userId === expectedUserId via telegram_links lookup
Backend → submits the on-chain UserOp
Backend → emits SSE → bot receives → bot replies "✅ Settled. Tx: 0x..."
```

**Security properties:**

- Tap-to-confirm is bound to the same chat_id + user_id that owns the intent.
- The endpoint refuses any intent whose tier ≠ `inline`. A bot-worker compromise cannot escalate a $500 intent into an inline confirm.
- The on-chain audit row records `source: 'telegram_inline'`.

**Latency:** the inline tap returns the on-chain settlement notification directly back to the chat.

## Tier 2 — Mini-App OTP ($200–$5K)

**Flow:**

```
You → /buy 1000 RWA1
Bot → classifies as 'mini_app_otp'
Bot → POSTs intent to backend → backend mints intentId + OTP
Backend → delivers OTP via passkey-auth'd webhook (today: registered email)
Bot → renders message with Mini-App launch button + OTP:
        "OTP: 184329 (valid for 5 minutes)
         [📱 Open Mini App]"
You → tap "Open Mini App"
Telegram → opens https://tg.muhaven.app/?intent=oci_xxx inside Telegram
Mini App → fetches intent details (cleartext quote, NAV, share estimate)
Mini App → prompts for the 6-digit OTP
You → enter OTP
Mini App → POSTs /api/v1/agent/openclaw/intent/confirm
        body: { intentId, otp, telegramInitData }
Backend → verifies Telegram initData HMAC against bot token
Backend → resolves user_id from telegram_links (initData branch wins over JWT)
Backend → asserts intent.tier === 'mini_app_otp'
Backend → asserts intent.userId === resolvedUserId (404 if mismatch)
Backend → submits the on-chain UserOp
Bot ← SSE notification ← Backend
Bot → "✅ Settled. Tx: 0x..."
```

**Security properties:**

- The OTP is short-lived (5 minutes), single-use, and bound server-side to `(intentId, telegramUserId)`.
- Telegram `initData` is HMAC-verified against the bot token — even a phishing Mini App can't fake initData.
- The audit row records `source: 'mini_app'`.
- The exact OTP-delivery channel is intentionally flexible: today the OTP is returned in the bot message itself for simplicity.

**Latency:** depends on how fast you retrieve and enter the OTP; once submitted, settlement mirrors the inline tier.

## Tier 3 — Passkey deeplink (>$5K)

**Flow:**

```
You → /buy 10000 RWA1
Bot → classifies as 'passkey_deeplink'
Bot → POSTs intent to backend → mints intentId
Bot → renders message with deeplink:
        "For >$5K, confirm with your passkey on the dashboard.
         [🔑 Open passkey dashboard]"
You → tap the button → default browser opens https://muhaven.app/agent/confirm?intent=oci_xxx
Dashboard → loads the ConfirmIntentPage
Dashboard → fetches intent details (cleartext quote, NAV, share estimate)
Dashboard → renders cleartext preview + "Confirm with passkey" button
You → tap Confirm
Dashboard → invokes WebAuthn ceremony (passkey assertion)
Dashboard → POSTs /api/v1/agent/openclaw/intent/confirm
        body: { intentId, passkeyAssertion }
Backend → asserts intent.tier === 'passkey_deeplink'
Backend → asserts source === 'dashboard_passkey'
Backend → verifies passkeyAssertion (presence check; full WebAuthn verify is the upgrade target)
Backend → submits the on-chain UserOp
Dashboard → SSE notification → "Settled" + Arbiscan link
Bot → also notified via SSE → Telegram message "✅ Settled."
```

**Security properties:**

- Passkey RP-ID hard-pinned to the dashboard origin (`muhaven.app`). A Telegram-MITM cannot complete the ceremony.
- The passkey ceremony is rooted in WebAuthn — the strongest auth primitive in the stack.
- The audit row records `source: 'dashboard_passkey'`.

::: warning Tier 3 passkey assertion
The current build ships a presence-check `passkeyAssertion`. The backend rejects empty/missing assertions (401) but accepts any non-empty value. **The dashboard JWT itself is passkey-rooted via the ZeroDev-powered MuHaven wallet registration**, so the demo-path security is acceptable — but a stolen JWT (CSRF, leaked refresh, XSS sibling tab) could complete a >$5K confirm without re-touching a passkey. A full `navigator.credentials.get()` assertion + server-side `@simplewebauthn/server.verifyAuthenticationResponse` is the planned hardening; the wire shape is already in place so the upgrade is purely additive.
:::

## Cross-tier audit honesty

Each tier emits a different `source` in the audit log:

| Tier | Source |
|---|---|
| Inline | `telegram_inline` |
| Mini-App OTP | `mini_app` |
| Passkey deeplink | `dashboard_passkey` |

The `source` is **server-derived** from the auth path — investors and bot workers cannot spoof it. A `telegram_inline` row guarantees the action settled via the inline tier; a `dashboard_passkey` row guarantees the WebAuthn ceremony fired.

This is the **server-derived-source pattern** — the audit log is honest about *how* an action was confirmed, not just *that* it was confirmed.

## Where next

- [Telegram bot](/openclaw/telegram-bot) — link your Telegram, send commands.
- [Available tools](/openclaw/tools) — the 11-tool subset.
- [Audit log](/policy/audit-log) — what's recorded per tier.
