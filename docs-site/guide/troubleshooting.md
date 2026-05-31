---
title: Troubleshooting & FAQ
description: Fixes for the common stalls when testing MuHaven — encrypted-balance buy-gate, faucet limits, passkey RP-ID, and async waits.
---

# Troubleshooting & FAQ

Most "it's stuck" moments are one of a handful of expected behaviours. Search this page
(press <kbd>/</kbd>) for your symptom.

## The buy button is disabled and asks me to "Reveal" {#buy-gate}

**This is expected, not a bug.** Your mhUSDC balance is encrypted, so the app can't tell
whether it covers the purchase until you reveal it.

**Fix:** click **Reveal mhUSDC balance** in the trade form. It's a one-tap local decrypt
(a permit) — **no transaction, no on-chain leak**. Once revealed:

- If you have enough, the **Buy** button enables.
- If you're short, you'll see a **Short $X** hint and a **Top up cash** link to
  [Deposit](/guide/investor/deposit).

Full detail: [I5 · Buy a position](/guide/investor/buy).

## The faucet won't give me USDC {#faucet-limits}

Circle's faucet limits how much each address can claim per time window.

**Fixes:**

- Wait out the cooldown and try again — you only need a small amount (≈ $100 test USDC)
  for the whole guide.
- Fund a **second address** (create another account) if you need more immediately.
- Make sure you selected **Arbitrum Sepolia** (not Ethereum Sepolia or another chain) in
  the faucet.

You do **not** need ETH — gas is sponsored.

## My passkey "isn't valid for this domain" {#passkey-rp-id}

A passkey is cryptographically bound to the **exact domain** where you created it
(WebAuthn "RP ID"). A passkey made on a staging or local URL won't authenticate on the
production app, and vice-versa.

**Fix:** register a **fresh passkey on the domain you're testing**. For the public app
that's [muhaven.app](https://muhaven.app). If you previously made a passkey on an old
domain, just create a new account on the current one.

## A step is taking longer than I expected {#async-waits}

Some flows are intentionally asynchronous:

| Flow | Typical wait | Why |
|---|---|---|
| Any single transaction | ~30–60s | One Arbitrum Sepolia block to confirm. |
| **Withdraw mhUSDC → USDC** | ~1–3 min (sometimes more) | Two phases: burn, then a homomorphic-decryption round-trip, then the USDC payout. See [I11](/guide/investor/withdraw). |
| **Yield distribution** (issuer) | ~30–60s per phase | Encrypted snapshot + coprocessor decrypt. See [S3](/guide/issuer/distribute-yield). |
| **Redemption-queue settlement** | Until the next epoch processes | Your over-cap sell settles in a later round. See [I9](/guide/investor/redemption-queue). |

If a page shows a spinner past these windows, refresh — most flows **resume from on-chain
state** and won't lose your progress.

## My balance shows a lock icon instead of a number {#encrypted-balance}

That's the encrypted balance. Click **Reveal** (the eye icon) to decrypt it **locally**
for your eyes only. Nothing is sent on-chain; no one else can reveal your balance. See
[I6 · Reveal your balance](/guide/investor/reveal-balance).

## I can't buy a specific token — it says "not listed" or "winding down"

Token availability is per-token state:

- **Not yet listed on-chain** — the token isn't deployed/active yet; the buy CTA is
  disabled.
- **Winding down / view-only** — the token is being retired; you can sell but not buy.

Pick another token from the [marketplace](/guide/investor/marketplace).

## A buy fails with a "stale NAV" style error

Each token's price (NAV) must be fresh (updated within the last day) for a buy to go
through. On the demo testnet this is normally kept current. If you hit it, try again
shortly or pick another token — it's a freshness gate, not a problem with your account.

## The agent won't execute a trade on its own

Autonomous execution requires a **scoped session** at the right tier. If the agent only
*proposes* (gives you a confirm link), either:

- you're in **Advisory / Confirm-per-action** — approve via the deep-link
  ([H5](/guide/agent/deep-link-confirm)), or
- you haven't granted a **Scoped** session yet — do that in
  [H3 · Set the tier](/guide/agent/set-tier).

To stop the agent at any time, use the [pause / kill-switch](/guide/agent/pause).

## Asking the agent to "rebalance" via an external MCP tool returns "not implemented"

Multi-leg **rebalance runs through HavenBot in the dashboard** (and the Portfolio
"Rebalance to targets" panel), not the standalone external `position.rebalance` MCP tool,
which intentionally returns `not_implemented`. Use HavenBot — see
[H4 · Autonomous execution](/guide/agent/autonomous).

## A feature returns "not deployed"

`governance.*`, `read.protection_coverage`, and `read.kyc_attestation` return
`not_deployed` because those P11 contracts aren't on the demo testnet. That's expected —
see [Not in this guide](/guide/not-in-this-guide).

## Still stuck?

- Re-check [Before you begin](/guide/before-you-begin).
- Confirm the app version in the footer matches the latest deploy (rule out a cached tab —
  hard-refresh with <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>).
- Browse the deeper [HavenBot](/havenbot/troubleshooting) and [MCP](/mcp/troubleshooting)
  troubleshooting pages.
