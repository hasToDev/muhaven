---
title: Deposit into mhUSDC
description: Convert your testnet USDC into confidential mhUSDC, 1:1.
---

# Deposit into mhUSDC

<TaskMeta time="~1 min" role="Investor" needs="some testnet USDC (see Get test funds)" />

> **What you'll do:** Convert plaintext USDC into encrypted `mhUSDC` so your cash balance becomes confidential on-chain.

## Before you begin

::: tip
`mhUSDC` is MuHaven's confidential stablecoin. After this step, your balance is encrypted on-chain — only you can reveal it.
:::

## Steps

1. Go to `/cash`. The page has a 3-way toggle: **Deposit | Withdraw | Send**. Keep it on **Deposit**.
2. Enter a USD amount, or tap a quick chip: **$100**, **$1,000**, or **$5,000**.
3. Click **Convert to mhUSDC**.
4. Two steps run automatically: **Approve USDC**, then **Mint mhUSDC**. This takes about 60–120 seconds total.

## Expected result

<ExpectedResult>
You see the <strong>"USDC converted 1:1 into mhUSDC"</strong> success card. Your `mhUSDC` balance is now encrypted on-chain.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| The conversion seems stuck | Both steps are on-chain and take ~30–60s each — see [async waits](/guide/troubleshooting#async-waits). |
| You can't see your new mhUSDC value | The balance is encrypted by design — reveal it with one tap (see [Reveal your balance](/guide/investor/reveal-balance)). |

→ Next: [Browse the marketplace](/guide/investor/marketplace)
