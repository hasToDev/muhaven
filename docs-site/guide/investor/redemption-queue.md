---
title: Claim from the redemption queue
description: Claim a queued redemption once its epoch processes.
---

# Claim from the redemption queue

<TaskMeta time="~1 min + wait" role="Investor" needs="a queued redemption from a prior sell" />

> **What you'll do:** Claim a redemption that was queued because it exceeded the instant cap.

## Before you begin

::: info
You only have a queued request if a prior [Sell](/guide/investor/sell) exceeded the instant cap and escalated to the queue. If nothing escalated, you'll have nothing to claim here.
:::

## Steps

1. Go to `/redemptions`. The page header reads **Redemptions**.
2. Find your request in the list. Each shows a state: **Queued**, **Settled**, or **Cancelled**.
3. Wait for the issuer to run `processEpoch` — the state moves from **Queued** to **Settled** and the mhUSDC payout lands in your balance automatically.
4. Optionally click **Decrypt payout** to reveal the settled amount.

## Expected result

<ExpectedResult>
The request's state flips to <strong>Settled</strong> and the `mhUSDC` payout lands in your balance automatically when the issuer processes the epoch.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| The request is still **Queued** | Settlement waits for the issuer to run `processEpoch` — see [async waits](/guide/troubleshooting#async-waits). |

→ Next: [Transfer to a peer](/guide/investor/transfer)
