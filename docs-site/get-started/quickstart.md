---
title: Quickstart
description: Six minutes from passkey to first encrypted buy.
---

# Quickstart

Under six minutes. One passkey. One encrypted buy. We'll do it in HavenBot (the in-dashboard copilot) because it's the surface with the lowest setup cost — no terminal, no host config, no Telegram link.

Once you're done, the [Choosing a surface](/get-started/choosing-a-surface) page shows how to layer in the other surfaces (MCP, Telegram, hosted checkout) without re-onboarding.

| Step | Time budget |
|---|---|
| 1. Sign in with a passkey | ~30s |
| 2. Open HavenBot | ~15s |
| 3. Onboarding wizard (welcome → funding → first buy) | ~4 min (testnet faucet ~90s; on-ramp adds 1-2 min on prod) |
| 4. Pick your tier (optional) | ~30s |
| 5. Pick more surfaces (optional) | open-ended |

## Prerequisites

- A modern browser that supports WebAuthn passkeys (Chrome, Edge, Safari, Firefox — current versions).
- A device with a biometric authenticator (Touch ID, Windows Hello, Android fingerprint) **or** a YubiKey-style hardware key. iCloud Keychain / Google Password Manager / 1Password also work.
- A small amount of test mhUSDC (we'll show you the faucet step below). On production, an on-ramp swap is one click — testnet uses a free faucet.

::: tip Testnet vs production
The walkthrough below uses Arbitrum Sepolia (testnet). The `muhaven.app` dashboard supports both networks; switch in the top-right network selector. Steps are identical — only the funding source differs (faucet vs. on-ramp).
:::

## Step 1 — Sign in with a passkey

Open [https://muhaven.app](https://muhaven.app) and click **Sign in**.

1. A passkey dialog appears. Pick **Create a new passkey** (or **Use an existing one** if you've signed in before).
2. Approve with Touch ID / Windows Hello / your hardware key.
3. The first sign-in deploys your ZeroDev kernel smart account in the background — about 3 seconds. You don't need to do anything; just wait for the dashboard to load.

You now have a **passkey-bound smart account** on Arbitrum Sepolia. No seed phrase. No private key on your device.

::: warning One passkey, one role
A given passkey can be either an investor *or* an issuer, not both. If you plan to be an issuer, register a second passkey for that purpose — see [Investor vs issuer](/get-started/investor-vs-issuer).
:::

## Step 2 — Open HavenBot

In the sidebar, click **Agent**. You'll land on the **Onboarding** wizard at `/agent/onboarding`. It walks you through:

1. **Welcome** — a 60-second explainer with the "sealed-glass-envelope" copy (your balances are encrypted; you hold the key).
2. **Funding** — a button that takes you to the testnet mhUSDC faucet. Grab ~$100 of test stablecoin and come back.
3. **First buy** — pick a token (TBILL1, GOLD1, NOVUS, or OCEAN), enter an amount, and click **Continue**.

The wizard skips steps you've already done — close it and come back later if you need to.

## Step 3 — Have your first conversation

After onboarding, you're in HavenBot proper at `/agent`. Try one of:

- "Show me my portfolio."
- "What's the current NAV of TBILL1?"
- "Buy 50 mhUSDC of TBILL1."

For read-only questions ("show me", "what's"), HavenBot answers in-line — no confirmation needed.

For state-changing actions ("buy", "claim", "set policy"), HavenBot opens a **ConfirmModal**:

1. Cleartext preview of what's about to happen (amount, token, estimated shares).
2. Your wallet — the kernel — signs the UserOp with your scoped session key (default 1-hour TTL).
3. A small toast says "Signed → Bundler → Settling…" and then "Settled, see Arbiscan."

Welcome to MuHaven. You just made a confidential RWA purchase: the cleartext amount **never** left your browser. On-chain, only ciphertext.

## Step 4 — Pick your tier (optional, but recommended)

By default you're in **Advisory** tier — every action needs a passkey confirmation. After ≥5 confirmed actions you'll be offered a graduation to **Confirm-per-action** (session-key signs without re-prompting your passkey for 1 hour). Power users can opt into **Policy-bound** (the agent acts within your encrypted thresholds without per-action confirmation; breaches trigger a `RiskBreach` and an auto-pause).

Set your tier from `Sidebar → Policy → Tier`, or ask HavenBot: *"Switch me to Confirm-per-action."* See [Tiered autonomy](/policy/tiered-autonomy) for the full ladder.

## Step 5 — Pick more surfaces (optional)

You're done. From here you can:

- **Continue in HavenBot.** Read [HavenBot conversations & confirmations](/havenbot/conversations) and the [investor playbook](/havenbot/investor-playbook).
- **Install `@muhaven/mcp`** to talk to MuHaven from Claude Code / Claude Desktop / Cursor with your own LLM. See [MCP install](/mcp/install).
- **Link your Telegram** for phone-first access with three-tier confirmation. See [Telegram bot](/openclaw/telegram-bot).
- **(Issuers only)** create a hosted checkout link to sell to non-customer buyers. See [Hosted checkout for issuers](/checkout/for-issuers).

::: tip One account, every surface
Your passkey-bound kernel is the same account across all four surfaces. Linking your Telegram, authorizing the MCP broker, and minting a checkout link all bind back to the same on-chain identity — and the same audit log.
:::

## If something went wrong

- **Passkey dialog didn't appear** — check that your browser is up-to-date and that hardware-backed credentials are enabled. iCloud Keychain users on macOS need to enable it in System Settings → Passwords.
- **Sign-in succeeded but the dashboard is empty** — verify you're on Arbitrum Sepolia. Switch the network selector top-right.
- **Faucet wouldn't dispense** — testnet faucets are rate-limited. Wait a minute and retry, or use the on-ramp on production.
- **ConfirmModal shows an encrypted handle instead of a number** — that's the policy gate's safety net. Re-run the action; if it persists, see [HavenBot troubleshooting](/havenbot/troubleshooting).
- **Everything is unreachable** — check the [public metrics endpoint](https://api.muhaven.app/api/v1/public/metrics) for an outage signal, then ping the team.
