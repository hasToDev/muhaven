---
title: OpenClaw — Telegram bot
description: Link your Telegram, send your first command.
---

::: warning 🚧 In development — not in the Testing Guide
This surface is still being hardened and isn't part of the [Testing Guide](/guide/). The page below describes the intended design. To evaluate MuHaven today, use [HavenBot](/havenbot/overview) or the [MCP server](/mcp/overview).
:::

# The MuHaven Telegram bot

`@muhaven_bot` is MuHaven's phone-first surface. You link it to your MuHaven wallet once, and from then on you can drive read tools and tier-1 (≤$200) buys with a single tap.

## Step 1 — Start a chat with the bot

Open Telegram and search for `@muhaven_bot` (or the staging variant `@muhaven_stage_bot` if you're on stage). Tap **Start**. The bot replies:

```
Welcome to MuHaven 🪙

To link this Telegram account to your MuHaven wallet, run /link
in this chat. I'll give you a one-time code; paste it into your
dashboard at https://muhaven.app/agent → Settings → Telegram.

This is the only time you'll need a passkey for Telegram — once
linked, sub-$200 buys are one-tap.
```

## Step 2 — Link your MuHaven wallet

In the Telegram chat:

```
/link
```

The bot replies:

```
🔗 Link code: ABCD-1234

1. Open https://muhaven.app/agent → Settings → Telegram
2. Paste this code and confirm with your passkey
3. Once linked, your audit log will show "telegram_link_consumed"

This code expires in 5 minutes.
```

On the dashboard:

1. Navigate to `/agent → Settings → Telegram`.
2. Paste `ABCD-1234`.
3. Confirm with your passkey.

A small notification arrives in your Telegram chat: `✅ Linked. Try /portfolio.`

## Step 3 — Send your first command

| Command | What it does |
|---|---|
| `/portfolio` | `muhaven.read.portfolio` — shows your aggregate token list. |
| `/yields RWA1` | `muhaven.read.yields` for RWA1 — last 5 epochs. |
| `/buy 50 RWA1` | Tier-classified buy. ≤$200 → inline button. |
| `/claim RWA1 5` | Claim RWA1 yield for epoch 5. |
| `/pause` | Pause your agent. |
| `/audit` | Show last 10 audit rows. |
| `/help` | List all commands. |

### Example: a tier-1 buy

```
/buy 50 RWA1
```

The bot replies with an inline keyboard:

```
You're about to buy 50 mhUSDC of RWA1.

   Quote: ~49.85 shares @ NAV $1.003
   Tier:  Inline (≤$200)

   [✅ Confirm]   [❌ Cancel]
```

Tap **Confirm**. The bot:

1. Validates the tap is from the same Telegram user_id that's linked to the MuHaven wallet.
2. Calls the inline-confirmation endpoint with the service-secret + user-id assertion.
3. Settles on-chain.
4. Replies: `✅ Settled. Tx: 0xabc...`

The whole flow is one tap.

### Example: a tier-2 buy ($200-$5K)

```
/buy 1000 RWA1
```

The bot replies:

```
You're about to buy 1000 mhUSDC of RWA1.

   Quote: ~996.5 shares @ NAV $1.003
   Tier:  Mini-App OTP ($200–$5K)

   OTP: 184329 (valid 5 minutes). Open the Mini App and enter it.

   [📱 Open Mini App]
```

Tap **Open Mini App**. The Telegram Mini App opens inside Telegram showing:

- The cleartext quote (mhUSDC amount, share estimate, NAV).
- A 6-digit OTP input.

Enter the OTP from the bot message and tap **Confirm**.

Settlement and a Telegram reply mirror the tier-1 flow.

### Example: a tier-3 buy (>$5K)

```
/buy 10000 RWA1
```

The bot replies:

```
You're about to buy 10,000 mhUSDC of RWA1.

   Tier: Passkey deep-link (>$5K)

   For amounts above $5K, you confirm with your passkey on the
   dashboard. Tap the button below to open the confirmation page.

   [🔑 Open passkey dashboard]
```

Tap the button. Your default browser opens to `https://muhaven.app/agent/confirm?intent=oci_xxx`. The page shows the same cleartext preview as ConfirmModal; you confirm with your passkey. The bot updates the chat to `✅ Settled.` once the on-chain settlement notification arrives via SSE.

## Privacy properties

- The bot **never sees your MuHaven wallet signing key** — it operates through the backend over HTTPS with bot service-secret + Telegram `initData` HMAC verification.
- The bot **never sees encrypted balances** — same backend-aggregate property as MCP.
- The bot edge sees your Telegram chat_id, user_id, and the command text. Telegram's servers see your message (transport-level encryption, not E2EE in standard chat).
- The Mini App is served from `tg.muhaven.app` with a strict CSP — no third-party trackers.
- The OTP delivery channel (today: passkey-auth'd webhook) keeps the OTP out of the Telegram bot session entirely.

## Bot quirks

- **Inline buttons assume `chat.type === 'private'`.** Group chats and channels are explicitly refused — the bot won't action `/buy` in a group.
- **The `telegram_links` table stores both `telegramChatId` (PK) and `telegramUserId`** (Mini-App lookup). The two aren't equal outside private chats — the bot enforces `chat.type === 'private' && from.id === chat.id` for callback queries.
- **Service-secret discipline:** the inline-confirm and inline-deny endpoints reject any intent whose tier isn't `inline`. A compromised bot worker cannot escalate a `mini_app_otp` or `passkey_deeplink` intent without going through the user-driven surface.

## Unlinking

To unlink Telegram from your MuHaven wallet:

1. On the dashboard: `/agent → Settings → Telegram → Unlink`.
2. Confirm with your passkey.
3. The bot replies: `❌ Unlinked. Run /link again to re-bind.`

Your MuHaven wallet and audit log are unaffected — only the bot ↔ wallet binding is severed.

## Where next

- [Three confirmation tiers](/openclaw/confirmation-tiers) — the classifier and per-tier flow detail.
- [Available tools](/openclaw/tools) — what each Telegram command maps to.
- [Troubleshooting](/openclaw/troubleshooting) — common Telegram + skill issues.
