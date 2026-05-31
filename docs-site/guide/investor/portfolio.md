---
title: Read your portfolio
description: See your total value, allocation, and holdings on the portfolio dashboard.
---

# Read your portfolio

<TaskMeta time="~1 min" role="Investor" needs="signed in" />

> **What you'll do:** Read your portfolio dashboard — total value, allocation, and holdings — decrypting encrypted figures as needed.

## Before you begin

::: tip
Every encrypted holding has a **Decrypt** button — your values stay confidential until you choose to decrypt them locally.
:::

## Steps

1. Go to `/portfolio`.
2. In the hero, switch between the **Total Portfolio Value** and **Allocation** (donut chart) tabs to see your total value and how it's split.
3. Use the **Reveal All** button (top of the Holdings section) or click the **Decrypt** button on any holding card to decrypt that position.
4. In the stats strip below the hero, click the mhUSDC cell to reveal your encrypted cash balance.

::: info
If your USDC balance is 0, a faucet banner appears at the top — follow it to [Get funds](/guide/investor/get-funds).
:::

## Expected result

<ExpectedResult>
The dashboard shows your total value, allocation donut, a holdings grid, and an mhUSDC strip cell — and each <strong>Decrypt</strong> decrypts its figure into plaintext.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| A holding shows a lock | Click **Decrypt** on the holding card, or **Reveal All** at the top of the Holdings section (see [encrypted balance](/guide/troubleshooting#encrypted-balance)). |
| Values look stale after a recent action | Use the refresh control; on-chain settlement can take ~30–60s — see [async waits](/guide/troubleshooting#async-waits). |

→ Next: [Chat with HavenBot](/guide/agent/chat)
