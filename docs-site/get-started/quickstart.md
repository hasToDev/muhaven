---
title: Quickstart
description: From passkey to first encrypted buy.
---

# Quickstart

One passkey. One encrypted buy. We'll do it in HavenBot (the in-dashboard copilot) because it's the surface with the lowest setup cost — no terminal, no host config, no Telegram link.

Once you're done, the [Choosing a surface](/get-started/choosing-a-surface) page shows how to layer in the other surfaces (MCP, Telegram, hosted checkout) without re-onboarding.

The five steps below:

1. Sign in with a passkey.
2. Open HavenBot.
3. Run the onboarding wizard (welcome → funding → first buy).
4. Pick your tier (optional).
5. Pick more surfaces (optional).

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
3. The first sign-in deploys your **MuHaven wallet** (a ZeroDev-powered smart account) in the background, paymaster-sponsored. You don't need to do anything; just wait for the dashboard to load.

You now have a **passkey-bound MuHaven wallet** on Arbitrum Sepolia. No seed phrase. No private key on your device.

::: warning One passkey, one role
A given passkey can be either an investor *or* an issuer, not both. If you plan to be an issuer, register a second passkey for that purpose — see [Investor vs issuer](/get-started/investor-vs-issuer).
:::

## Step 2 — Run the onboarding wizard

In the sidebar, click **Agent** — that lands you on `/agent`. To go through the first-time wizard, navigate to **`/agent/onboarding`** (the dashboard doesn't auto-redirect; type the URL or follow a "Run onboarding" link from the page menu).

The wizard has three steps:

1. **Passkey ready** — auto-detected from your authentication state.
2. **KYC whitelist** — one click to add yourself to the ERC-3643 identity registry.
3. **First position** — the wizard drafts a 50-share buy of the first active token; you confirm with your passkey.

The wizard skips steps you've already done — if your MuHaven wallet already holds positions, you'll land on the celebrate screen instead.

::: tip Funding first
You need a small amount of **mhUSDC** in your MuHaven wallet for the first buy to succeed. On testnet, grab some from the mhUSDC faucet before launching the wizard. On production, use the dashboard's funding flow / on-ramp picker.
:::

## Step 3 — Have your first conversation

After onboarding, you're in HavenBot proper at `/agent`. Try one of:

- "Show me my portfolio."
- "What's the current NAV of `<TOKEN>`?"
- "Buy 50 mhUSDC of `<TOKEN>`."

For read-only questions ("show me", "what's"), HavenBot answers in-line — no confirmation needed.

For state-changing actions ("buy", "claim", "set policy"), HavenBot opens a **ConfirmModal**:

1. Cleartext preview of what's about to happen (amount, token, estimated shares).
2. Your MuHaven wallet signs the UserOp with your scoped session key (default 1-hour TTL).
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
Your passkey-bound MuHaven wallet is the same account across all four surfaces. Linking your Telegram, authorizing the MCP broker, and minting a checkout link all bind back to the same on-chain identity — and the same audit log.
:::

## If something went wrong

- **Passkey dialog didn't appear** — check that your browser is up-to-date and that hardware-backed credentials are enabled. iCloud Keychain users on macOS need to enable it in System Settings → Passwords.
- **Sign-in succeeded but the dashboard is empty** — verify you're on Arbitrum Sepolia. Switch the network selector top-right.
- **Faucet wouldn't dispense** — testnet faucets are rate-limited. Wait and retry, or use the on-ramp on production.
- **ConfirmModal shows an encrypted handle instead of a number** — that's the policy gate's safety net. Re-run the action; if it persists, see [HavenBot troubleshooting](/havenbot/troubleshooting).
- **Everything is unreachable** — check status with the MuHaven team.
