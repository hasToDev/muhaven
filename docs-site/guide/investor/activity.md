---
title: Review your activity
description: Verify every settlement in the activity feed and inspect transactions on Arbiscan.
---

# Review your activity

<TaskMeta time="~1 min" role="Investor" needs="any past transaction" />

> **What you'll do:** Use the activity feed to verify any settlement and open the underlying transaction on a public explorer.

## Before you begin

::: tip
This is your single source of truth for "did it actually happen?". Every buy, sell, yield claim, cash conversion, and transfer shows up here with a link to the on-chain transaction.
:::

## Steps

1. Go to `/activity`.
2. Narrow the feed with the filter pills: **All / Buy / Sell / Yield / Cash / Transfer**.
3. Read the rows, newest first — each shows an icon, type, token, timestamp, and amount.
4. For an encrypted amount, tap the per-row **Reveal** to decrypt it locally.
5. Click the transaction-hash link to open the transaction on `https://sepolia.arbiscan.io`.

## Expected result

<ExpectedResult>
You find the row for your action and open its transaction on Arbiscan — confirming the settlement, and that the amount is <strong>not</strong> stored in cleartext on-chain.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| A recent action isn't listed yet | On-chain settlement takes ~30–60s — see [async waits](/guide/troubleshooting#async-waits). |
| A row's amount is hidden | That amount is encrypted by design — tap **Reveal** to decrypt it locally (see [encrypted balance](/guide/troubleshooting#encrypted-balance)). |

→ Next: [Read your portfolio](/guide/investor/portfolio)
