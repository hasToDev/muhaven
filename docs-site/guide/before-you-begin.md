---
title: Before you begin
description: What you need to test MuHaven — a browser, a passkey, ~10–15 minutes, and testnet funds. No install, no ETH.
---

# Before you begin

You can test all of MuHaven from a browser. There is nothing to install.

<TaskMeta time="~2 min to read" role="Anyone" needs="A modern browser + a passkey device" />

## What you need

| Requirement | Detail |
|---|---|
| **A modern browser** | Chrome, Edge, Safari, or Firefox — recent version. |
| **A passkey device** | Touch ID / Face ID on a Mac or iPhone, Windows Hello, an Android phone, or a hardware security key. This *is* your login — there's no password. |
| **Testnet USDC** | Free from a faucet — see [Get testnet funds](/guide/investor/get-funds). |
| **~10–15 minutes** | The [happy path](/guide/happy-path) takes about 10. |

::: tip Easiest passkey option on Chrome/Android
When your device prompts you to save the passkey, choose **Google Password Manager** — it
stores the passkey in your Google account and syncs it across devices, so you don't need a
hardware key or a specific OS. It's the smoothest option for testing.
:::

::: tip You do NOT need ETH or any gas token.
MuHaven uses an [ERC-4337 smart account](/get-started/passkey-accounts) with **sponsored
gas**. Your transactions are paid for by the platform's paymaster, so you never buy or
hold ETH. The only testnet token you ever need is **USDC**, and that's free from a faucet.
:::

## How the money works (testnet)

Everything is play-money on **Arbitrum Sepolia**:

1. You get free **testnet USDC** from a faucet.
2. Inside MuHaven you convert it to **mhUSDC** — a *confidential* USDC wrapper whose
   balance is encrypted on-chain. mhUSDC is the currency you buy positions and receive
   yield in. ([Why "mhUSDC"?](/get-started/privacy-boundary))
3. When you're done you can convert mhUSDC back to USDC.

No real funds are ever at risk.

## The privacy idea in one paragraph

MuHaven holds your token balances **encrypted on-chain** using Fhenix CoFHE
(homomorphic encryption). Other people — including the platform operator — see that you
hold *something*, but not *how much*. **You** decrypt your own numbers locally with a
one-tap permit when you want to see them. That "reveal" moment is the privacy *aha* the
guide keeps pointing you at — most visibly in [Buy a position](/guide/investor/buy) and
[Reveal your balance](/guide/investor/reveal-balance).

## A few things that will save you time

::: warning Register a fresh passkey on the real domain
A passkey is bound to the exact website domain where you create it (WebAuthn "RP ID").
A passkey made on a staging or local URL **will not** work on the production app, and
vice-versa. Always register at the URL you intend to test on — for the public app that's
[**muhaven.app**](https://muhaven.app). See
[Troubleshooting](/guide/troubleshooting#passkey-rp-id).
:::

::: tip Encrypted balances need a "reveal" before some actions
Because balances are encrypted, the app sometimes can't tell whether you have enough to
proceed (e.g. buying) until you reveal. When that happens you'll see an inline **Reveal**
button — one tap, no transaction, no on-chain leak. This is expected, not an error.
:::

::: tip Some steps are intentionally async (~30–60s, occasionally minutes)
On-chain transactions take a block to confirm, and a few flows (yield distribution,
withdrawing mhUSDC back to USDC) involve a homomorphic-decryption round-trip that adds a
short wait. Each page tells you what to expect.
:::

→ Next: [**The 10-minute happy path**](/guide/happy-path)
