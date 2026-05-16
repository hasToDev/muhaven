---
title: HavenBot — onboarding
description: Under six minutes from passkey to first encrypted buy.
---

# Onboarding

HavenBot's onboarding wizard takes a first-time investor from "I just heard of MuHaven" to "I hold an encrypted RWA balance and have an audit row to prove it" in **under six minutes**. The flow follows a Wealthfront-style limits paragraph + the "sealed-glass-envelope" framing surfaced during Wave 4 user research.

## The four steps

The wizard at `/agent/onboarding` is gated by a `muhaven:onboarding:complete` localStorage flag plus a backend portfolio probe. If you've completed it before, you skip straight to the celebrate screen.

### Step 1 — Welcome (~60 seconds)

A short explainer that names the three properties that make MuHaven different:

- **Encrypted balances.** "Your token balances live on-chain like a sealed glass envelope. The chain can verify the envelope is real and the amount is non-negative — but only you can open it."
- **Tiered autonomy.** "You pick how much the agent does without asking. Today: ask me every time."
- **No seed phrase.** "We don't ever ask you to write down 12 words. Your passkey is the key."

Click **Get started** to advance.

### Step 2 — Funding (~90 seconds on testnet, ~3 minutes on production)

You need a small amount of confidential USDC (called **mhUSDC**) to buy your first RWA token.

**Testnet (Arbitrum Sepolia):**
- Click **Open faucet** — a new tab opens to the public mhUSDC testnet faucet.
- Paste your wallet address (the wizard shows it; click to copy).
- Request the daily drip; it usually lands in 5-10 seconds. (Some faucets dispense less than the full ~100 mhUSDC on first try; rerun if you need more.)
- Come back to the wizard tab and click **I've funded my wallet**.

**Production (Arbitrum One):**
- Click **Buy mhUSDC** — opens the on-ramp picker (Wave 5: pluggable to Sardine / Coinbase / MoonPay).
- Pay with card / Apple Pay / Google Pay.
- Wait for on-ramp settlement (~2-3 minutes).

The wizard polls your mhUSDC balance and advances automatically once funds land.

::: warning Wrap-to-mhUSDC leaks
The wrap from USDC → mhUSDC is the one MuHaven flow that leaks deposit size to a chain observer. Mitigations (batching, delays, CCTP) are tracked for Wave 5. If your deposit size needs to stay private, wait for the Wave 5 mitigation or use the issuer-minted hosted checkout flow (which routes through a non-customer kernel).
:::

### Step 3 — First buy (~2 minutes)

The wizard shows a tile per active RWA token (TBILL1, GOLD1, NOVUS, OCEAN today):

- **TBILL1** — Tokenized short-duration US Treasuries. Low-risk yield.
- **GOLD1** — Tokenized gold. Inflation hedge.
- **NOVUS** — Tokenized growth basket.
- **OCEAN** — Tokenized ocean-cargo-shipping receivables. Higher yield, higher risk.

Pick one, enter an amount (default 50 mhUSDC), and click **Continue**. The wizard hands off to ConfirmModal:

1. Cleartext preview: amount, estimated shares, current NAV, slippage.
2. **Confirm** — your kernel signs the UserOp with the session key.
3. Toast: "Signed → Bundler → Settling…"
4. Toast: "Settled. View on Arbiscan."

You now hold an encrypted balance of your first RWA token. The ConfirmModal closes; the wizard advances to step 4.

### Step 4 — Celebrate + next steps

A success screen with three calls to action:

- **Set your tier.** Default is Advisory (every action prompts your passkey). Most users graduate to Confirm-per-action within their first session.
- **Link Telegram.** Open `/settings → Telegram` to bind your kernel to a Telegram chat for phone-first access.
- **Install MCP.** Open `/settings → MCP` for the device-code authorization flow that lets Claude Code / Desktop / Cursor talk to MuHaven.

Click **Done**. The wizard sets `muhaven:onboarding:complete=true` in localStorage. Future visits go straight to `/agent`.

## What if I close the wizard partway?

The wizard restores state from a backend portfolio probe + localStorage:

| You did | Next visit lands on |
|---|---|
| Nothing | Step 1 (welcome) |
| Funded but didn't buy | Step 3 (first buy) |
| Bought but didn't ack the celebrate | Step 4 (celebrate) |
| Acknowledged celebrate | `/agent` proper (no wizard) |

You can always re-open the wizard from `/agent → ⋯ menu → Run onboarding again`.

## Issuer onboarding

The investor onboarding wizard runs only for `role === 'investor'` kernels. Issuers see a different `/agent/onboarding` flow:

1. Welcome (issuer-specific copy).
2. Verify your KYB metadata (legal name, jurisdiction).
3. Pick a token symbol to issue.
4. F2 wizard step 6 (set initial NAV + unpause) — uses `muhaven_propose_unpause_token` so the **issuer kernel** signs (production-trajectory shape, not the deployer-side script).

The issuer wizard skips the funding step (issuers don't need mhUSDC to operate) and adds a "set up your first investor whitelist" call to action at the end.

## How long does it really take?

P95 timings from internal testing (5-investor sample, Wave 4 closeout):

| Step | Median | P95 |
|---|---|---|
| Step 1 (welcome) | 45s | 60s |
| Step 2 (testnet faucet) | 90s | 180s |
| Step 2 (on-ramp) | 2m | 4m |
| Step 3 (first buy) | 1m 30s | 2m 30s |
| Step 4 (celebrate) | 15s | 45s |
| **Total (testnet)** | **~4 minutes** | **~6 minutes** |

The "under 6 minutes" target is the P95 on testnet. Production is ~2 minutes longer because of on-ramp latency.

## Troubleshooting

- **Funding step won't advance** — the wizard polls your mhUSDC balance every 5 seconds. If the faucet succeeded but the poll hasn't picked it up, click **I've funded my wallet** manually.
- **First buy fails with `BalanceTooLow`** — your mhUSDC balance is below the amount. Faucet doesn't always dispense the full 100 mhUSDC on first try; refresh and retry.
- **ConfirmModal shows `decryptForView` errors** — your permit may have expired. Refresh the page; HavenBot re-mints the permit on next action.
- **Wizard re-opens on every visit** — localStorage may be disabled in your browser settings. Whitelist `muhaven.app` or use a different browser.

See [HavenBot troubleshooting](/havenbot/troubleshooting) for more.
