---
title: Get test funds
description: Get free testnet USDC from the Circle faucet so you can start testing MuHaven.
---

# Get test funds

<TaskMeta time="~1–2 min" role="Investor" needs="a MuHaven account (see Sign in)" />

> **What you'll do:** Fund your MuHaven wallet with free testnet USDC from the Circle faucet.

## Before you begin

::: info
You do **not** need ETH. Gas is sponsored — you never pay transaction fees on MuHaven testnet.
:::

## Steps

1. Open the **Cash** page from the sidebar (or **Portfolio**, which shows a faucet banner whenever your USDC balance is 0).
2. Copy your wallet address (the **Copy** button on Cash, or the address chip in the Portfolio banner — you can also scan the QR code on Cash).
3. Click **Get test USDC** on Cash (the Portfolio banner's button is labelled **Open faucet**) to open `https://faucet.circle.com/`.
4. On the Circle faucet, select the **Arbitrum Sepolia** network.
5. Paste your wallet address and click **Send 20 USDC**.
6. Return to MuHaven and watch the USDC tile.

## Expected result

<ExpectedResult>
Within about a minute, the USDC tile shows a gold bloom and a <strong>"+$X received"</strong> indicator — your testnet USDC has landed.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| Faucet says you've requested too recently | The Circle faucet rate-limits requests — see [faucet limits](/guide/troubleshooting#faucet-limits). |
| Funds don't appear after a minute or two | Confirm you selected **Arbitrum Sepolia** and pasted the exact address from MuHaven. |

→ Next: [Deposit into mhUSDC](/guide/investor/deposit)
