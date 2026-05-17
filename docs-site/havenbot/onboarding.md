---
title: HavenBot — onboarding
description: From passkey to first encrypted buy.
---

# Onboarding

HavenBot's onboarding wizard takes a first-time investor from "I just heard of MuHaven" to "I hold an encrypted RWA balance." The wizard lives at `/agent/onboarding` — you reach it by typing the URL or following the link from your dashboard sidebar.

## The three steps (plus a celebrate screen)

The wizard at `/agent/onboarding` is gated by a `muhaven:onboarding:complete` localStorage flag plus a backend portfolio probe. If you've completed it before — or if your MuHaven wallet already holds positions — you skip straight to the celebrate screen.

### Step 1 — Passkey ready

The wizard checks your authentication state and confirms your passkey is bound to a MuHaven wallet. If you arrived from the dashboard sign-in flow you'll see this step as already complete; the wizard auto-advances to Step 2.

### Step 2 — KYC whitelist

Confidential RWAs are issued under ERC-3643, which requires every transfer to read an "is whitelisted" bit on a compliance registry. The wizard runs a one-click self-whitelist call against the MuHaven identity registry. Your identity stays private — only the boolean whitelist flag is read on each transfer.

Click **Whitelist me**. The button calls the `demoApi.whitelistSelf` endpoint and waits for confirmation. On success, a toast says "KYC complete" and the wizard advances.

::: tip Dev-mode bypass
On the current build, the MuHaven identity registry runs in dev mode — `isVerified` always returns true, so the on-chain compliance check is a no-op. The wizard still walks you through the self-whitelist click so the production flow shape stays familiar. When dev mode is turned off, this same click will trigger the real whitelist add.
:::

### Step 3 — First position

A small buy seals your portfolio. The wizard:

1. Looks up the first active token in the catalog and selects it as the target.
2. Drafts a `propose_buy` for 50 shares.
3. Opens ConfirmModal with a cleartext preview (amount, estimated shares, current NAV, slippage).
4. You confirm — your MuHaven wallet signs the UserOp with the session key.
5. The amount and share count are FHE-encrypted on Arbitrum before settlement.

A toast cycle of "Signed → Bundler → Settling…" then "Settled. View on Arbiscan." closes the loop, and the wizard advances to the celebrate screen.

### Celebrate + next steps

A success screen with three calls to action:

- **Set your tier.** Default is Advisory (every action prompts your passkey). Most users graduate to Confirm-per-action within their first session.
- **Link Telegram.** Bind your MuHaven wallet to a Telegram chat for phone-first access.
- **Install MCP.** Run the device-code authorization flow that lets Claude Code / Desktop / Cursor talk to MuHaven with your own LLM.

Click **Done**. The wizard sets `muhaven:onboarding:complete=true` in localStorage. Future visits go straight to `/agent`.

## What if I close the wizard partway?

The wizard restores state from a backend portfolio probe plus localStorage:

| You did | Next visit lands on |
|---|---|
| Nothing | Step 1 (passkey check) |
| Whitelisted but no buy | Step 3 (first buy) |
| Bought but didn't acknowledge | Celebrate screen |
| Acknowledged celebrate | `/agent` chat (no wizard) |

If your MuHaven wallet already holds positions when the wizard mounts (e.g., you bought through another surface or a different device), the wizard treats both the KYC and first-buy steps as already complete and lands you on celebrate.

You can always re-open the wizard from `/agent → ⋯ menu → Run onboarding again`.

## Issuer onboarding

The investor onboarding wizard runs only for investor-roled MuHaven wallets. Issuers go through a different flow at `/apply-issuer` for KYB onboarding, and then use HavenBot's issuer-side tools (distribute yield, KYC churn, unpause new tokens) from the regular `/agent` route.

## Troubleshooting

- **KYC step won't complete** — the whitelist API may be unreachable. Refresh; if it persists, ping the MuHaven team.
- **First buy fails with `BalanceTooLow`** — you don't have enough mhUSDC for a 50-share purchase. Top up via the dashboard's funding flow (or testnet faucet) and re-run the wizard.
- **ConfirmModal shows `decryptForView` errors** — your permit may have expired. Refresh the page; HavenBot re-mints the permit on next action.
- **Wizard re-opens on every visit** — localStorage may be disabled in your browser settings. Whitelist `muhaven.app` or use a different browser.

See [HavenBot troubleshooting](/havenbot/troubleshooting) for more.
