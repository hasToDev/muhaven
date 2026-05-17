---
title: OpenClaw — phone-first playbook
description: Real scenarios for driving MuHaven from Telegram while you're on the move.
---

# OpenClaw + Telegram playbook

A library of **phone-first scenarios** — each one shows the actual Telegram chat from start to settled, so you know what to expect before you're standing on a train platform trying to remember the command name.

> Throughout this page, `<TOKEN>` and `RWA1` stand in for whichever active RWA token you hold. Your `/tokens` command lists what's currently in your catalog.

## 1. Morning commute — portfolio check + claim if anything ripe

You're on the train. You want a quick pulse on the portfolio and, if there's any pending yield, claim it before you get to the office.

```
You → /portfolio

@muhaven_bot → 🪙 You hold 3 RWA tokens.
                  Status: balanced · last sync 09:08 UTC
                  Pending yield this week: $14.20

You → What's claimable right now?

@muhaven_bot → 1 claim available:
                  • <TOKEN> epoch 7 — $14.20 (encrypted)
                  Use /claim <TOKEN> 7 to claim.

You → /claim <TOKEN> 7

@muhaven_bot → Claim <TOKEN> yield for epoch 7?
                  Estimated payout: $14.20 (encrypted)
                  Tier: Inline (claim is fee-bearing pull)
                  [✅ Confirm]  [❌ Cancel]

You → (tap ✅ Confirm)

@muhaven_bot → ✅ Claimed. Tx: 0xabc... (View on Arbiscan)
```

No browser, no laptop, no passkey ceremony.

## 2. Claim from bed — overnight yield notification

You set up notifications. The bot pings you when a new epoch finalizes and there's yield to claim. You roll over, tap, sleep.

```
@muhaven_bot → 🔔 New yield ready
                  <TOKEN> epoch 8 just finalized.
                  Your share: ~$12.80 (encrypted)
                  Tap to claim:
                  [💰 Claim now]   [⏰ Remind me tomorrow]

You → (tap 💰 Claim now)

@muhaven_bot → Claim <TOKEN> yield for epoch 8?
                  Tier: Inline (≤$200)
                  [✅ Confirm]  [❌ Cancel]

You → (tap ✅ Confirm)

@muhaven_bot → ✅ Claimed. Goodnight 🌙
```

The notification message bundles the next step's button, so the whole flow is two taps and never leaves the conversation.

## 3. Mid-tier buy on the train — Mini App + OTP

A $1,000 buy lands in tier 2 (Mini-App OTP). You're on the train; you have wifi but want the extra friction step before signing.

```
You → /buy 1000 <TOKEN>

@muhaven_bot → You're about to buy 1,000 mhUSDC of <TOKEN>.
                  Quote: ~996.5 shares @ NAV $1.003
                  Tier:  Mini-App OTP ($200–$5K)
                  OTP: 184329 (valid 5 minutes)
                  [📱 Open Mini App]

You → (tap 📱 Open Mini App)

(Mini App opens inside Telegram, shows the same quote + an OTP input)

You → (enter 184329, tap Confirm)

@muhaven_bot → ✅ Settled. Tx: 0xdef...
```

**Why this tier exists:** sub-$200 inline taps are the right friction floor for coffee-money buys; >$5K trades deserve a full passkey ceremony. Mini-App OTP sits in the middle — fast enough that you don't bail on the buy, slow enough that an accidental tap doesn't move $1K.

## 4. Big trade — passkey deeplink to dashboard

A $10,000 buy lands in tier 3. The bot can't drive WebAuthn from inside Telegram (no DOM), so it hands you a deeplink to the dashboard's `/agent/confirm` page where your passkey can sign.

```
You → /buy 10000 <TOKEN>

@muhaven_bot → You're about to buy 10,000 mhUSDC of <TOKEN>.
                  Tier:  Passkey deep-link (>$5K)
                  For amounts above $5K, you confirm with your
                  passkey on the dashboard.
                  [🔑 Open passkey dashboard]

You → (tap 🔑 Open passkey dashboard)

(Default browser opens https://muhaven.app/agent/confirm?intent=oci_xxx
 — shows the same cleartext preview, with a passkey confirm button)

You → (tap Confirm with passkey, approve with Touch ID)

(Page renders ✅ Settled with Arbiscan link)

@muhaven_bot → ✅ Settled. Tx: 0xfeed... (notified via SSE)
```

The Telegram chat updates automatically via SSE — you don't have to come back to it.

## 5. Pause from anywhere — laptop just got stolen edition

You're at the airport. You left your laptop in the lounge and a stranger walked off with it. Pause from your phone:

```
You → /pause

@muhaven_bot → ⏸ Agent paused.
                  On-chain validator uninstalled in block 8214321.
                  All propose tools will return 423 PAUSED.
                  To resume, open https://muhaven.app/agent on a
                  trusted device and complete the WebAuthn ceremony.
```

The pause cascades **globally** — HavenBot, MCP, the laptop's browser tab, the OpenClaw skill on your homelab, every surface now rejects propose calls until you resume. ≤1 Arb block.

## 6. Tier transition — switching from Confirm-per-action to Advisory before a busy day

Tier transitions can't be done from Telegram (they need the dashboard ceremony), but you can ask the bot to prepare the deeplink:

```
You → I want to switch back to Advisory tier for today

@muhaven_bot → Tier transitions live on the dashboard so the
                  passkey ceremony fires. Deeplink:
                  https://muhaven.app/agent/policy/transition
                  [🔑 Open tier picker]

You → (tap, sign with passkey on dashboard)

@muhaven_bot → ✅ Tier updated. You're now in Advisory.
                  Every buy/claim will prompt your passkey.
```

## 7. Audit triage on the platform — "wait, what did I do yesterday?"

You think you remember a Tuesday-night buy that went through Telegram inline. You want to verify.

```
You → /audit

@muhaven_bot → Last 10 audit rows:
                  • Tue 23:14 propose_buy <TOKEN> 80 mhUSDC
                    [source: telegram_inline · settled]
                  • Tue 22:47 propose_buy RWA1 50 mhUSDC
                    [source: telegram_inline · settled]
                  • Mon 09:14 propose_claim <TOKEN> ep6
                    [source: dashboard_session_key · settled]
                  • ...

You → How much did I spend on Telegram inline yesterday?

@muhaven_bot → Tuesday Telegram inline:
                  2 buys, $130 total ($80 <TOKEN> + $50 RWA1).
                  Both settled successfully.
```

The audit `source` field is server-derived — the bot can't lie about which surface confirmed a trade.

## 8. Yield digest — "what did each token pay this month?"

```
You → How did each of my tokens pay this month?

@muhaven_bot → May 2026 yield by token:
                  • <TOKEN>  $14.20 (1 epoch, claimed)
                  • RWA1    $11.80 (1 epoch, not yet claimed)
                  • RWA2     $0.00 (no epoch this month)
                  Total claimed: $14.20 · Pending: $11.80
                  Use /claim RWA1 <epoch> to grab the pending one.
```

## 9. Distribution status — "is my claim window still open?"

```
You → /distribution <TOKEN> 7

@muhaven_bot → <TOKEN> epoch 7:
                  Status:        finalized · claim window OPEN
                  Total funded:  $50,000
                  Your share:    ~$14.20 (encrypted)
                  Claim deadline: 2026-06-15 23:59 UTC
                  Use /claim <TOKEN> 7 to claim.
```

## 10. Linking a second device — "can I use the bot from my tablet too?"

```
You → /link

@muhaven_bot → 🔗 Link code: WXYZ-5678
                  This Telegram account is already linked to
                  MuHaven wallet 0x1234…cdef. Running /link
                  from a different device would re-bind to that
                  device's Telegram account; you don't need to
                  re-link the same Telegram account on a new phone.
                  Telegram syncs the chat across your devices
                  automatically.
```

Your Telegram account is what's linked to your MuHaven wallet — not a specific device. Install Telegram on a new device, sign into the same account, and the bot just works.

## Tips for the phone surface

1. **Use commands, not prose.** The bot is a deterministic command interpreter, not an LLM. `/buy 50 <TOKEN>` always works; "buy me fifty of `<TOKEN>` please" doesn't.
2. **Don't fight the tier classifier.** If you're trying to buy $250, it goes to Mini-App OTP. There's no per-user override; that's intentional.
3. **Pause is global.** Pausing from Telegram pauses HavenBot, MCP, every surface. That's the kill-switch's job.
4. **Tier transitions need the dashboard.** Telegram can deeplink you there; it can't drive the WebAuthn ceremony itself.
5. **The bot never holds your key.** It can prepare actions and send the inline buttons; the actual signing happens server-side (with strict tier + user-id verification) or on the dashboard (passkey ceremony).

## Where next

- [Available tools](/openclaw/tools) — full reference for every command above.
- [Three confirmation tiers](/openclaw/confirmation-tiers) — exactly what each tier does.
- [Telegram bot](/openclaw/telegram-bot) — link your account, the first command.
- [Troubleshooting](/openclaw/troubleshooting) — common skill + bot issues.
