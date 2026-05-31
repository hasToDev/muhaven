---
title: Claim yield
description: Claim confidential yield payouts from funded epochs on the Yields page.
---

# Claim yield

<TaskMeta time="~2 min" role="Investor" needs="a holding in a token an issuer has distributed yield for" />

> **What you'll do:** Claim a confidential yield payout from a funded epoch.

## Before you begin

::: important
A claimable epoch only exists **after an issuer distributes yield** for a token you hold — see [S3 · Distribute yield](/guide/issuer/distribute-yield). If you have no claimable epochs yet, that's expected, not an error.
:::

## Steps

1. Go to `/yields` and pick a token.
2. Use the time-range pills — **1M / 3M / 6M / 1Y** — to scope the NAV trend chart and epoch list.
3. Scan the list of yield epochs. Each row shows a date and a status: **ready to claim**, **claimed — credited to mhUSDC**, or **awaiting funding**.
4. Click **Claim** (enabled only when the epoch is **ready to claim**).

::: tip
Deep-links like `/yields?token=…&epoch=…` highlight a specific row when you arrive from elsewhere.
:::

## Expected result

<ExpectedResult>
The epoch's status changes from <strong>ready to claim</strong> to <strong>claimed — credited to mhUSDC</strong>, and your `mhUSDC` balance reflects the payout.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| No claimable epochs appear | None have matured yet — an issuer must distribute yield first (see [Distribute yield](/guide/issuer/distribute-yield)). |
| A row shows **awaiting funding** | The epoch isn't funded yet — wait for the issuer to distribute yield, see [async waits](/guide/troubleshooting#async-waits). |

→ Next: [Claim from the redemption queue](/guide/investor/redemption-queue)
