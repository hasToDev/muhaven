---
title: Read your portfolio
description: See your total value, allocation, cash buffer, and holdings on the portfolio dashboard.
---

# Read your portfolio

<TaskMeta time="~1 min" role="Investor" needs="signed in" />

> **What you'll do:** Read your portfolio dashboard — total value, allocation, cash buffer, and holdings — revealing encrypted figures as needed.

## Before you begin

::: tip
Every encrypted figure on this page has a **Reveal** (Eye icon) — your values stay confidential until you choose to decrypt them locally.
:::

## Steps

1. Go to `/portfolio`.
2. In the hero, switch between the **Value** and **Allocation** (donut chart) tabs to see your total value and how it's split.
3. Use the refresh control to pull the latest on-chain state.
4. On the **mhUSDC Cash Buffer** card, tap **Reveal** (Eye icon) to decrypt it, or use **Top up** to add more on `/cash`.
5. In the holdings grid, tap **Reveal balance** on any token card to decrypt that position.
6. Check the yield summary for an at-a-glance view of accrued yield.

::: info
If your USDC balance is 0, a faucet banner appears at the top — follow it to [Get funds](/guide/investor/get-funds).
:::

## Expected result

<ExpectedResult>
The dashboard shows your total value, allocation donut, an <strong>mhUSDC Cash Buffer</strong> card, and a holdings grid — and each <strong>Reveal</strong> decrypts its figure into plaintext.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| A holding or the cash buffer shows a lock | Tap **Reveal** / **Reveal balance** to decrypt it locally (see [encrypted balance](/guide/troubleshooting#encrypted-balance)). |
| Values look stale after a recent action | Use the refresh control; on-chain settlement can take ~30–60s — see [async waits](/guide/troubleshooting#async-waits). |

→ Next: [Chat with HavenBot](/guide/agent/chat)
