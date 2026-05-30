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

1. Go to `/redemptions`. The header reads **Redemption queue**.
2. Find your request in the list. Each shows a state: **Queued**, **Claimed**, or **Cancelled**.
3. Wait for the epoch to process — the state moves from **Queued** to ready.
4. Optionally tap **Reveal** (Eye icon) to decrypt the payout.
5. Click **Claim** (enabled once the request is ready).

## Expected result

<ExpectedResult>
The request's state flips to <strong>Claimed</strong> and the `mhUSDC` payout lands in your balance.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| The request is still **Queued** | Settlement waits for the next epoch to process — see [async waits](/guide/troubleshooting#async-waits). |
| **Claim** is disabled | The request isn't ready yet; wait for the state to change before claiming. |

→ Next: [Transfer to a peer](/guide/investor/transfer)
