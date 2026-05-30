---
title: Tokens dashboard
description: Review your issued tokens, aggregates, and per-token detail.
---

# Tokens dashboard

<TaskMeta time="~1 min" role="Issuer" needs="Approved issuer with ≥1 token" />

> **What you'll do:** Review your issued tokens and their aggregate performance in one master-detail view.

## Before you begin

::: info Prerequisites
- You're an **approved issuer** with at least one issued token.
:::

## Steps

1. Go to `/tokens`.
2. Read the top aggregate strip: **Total AUM**, **Total Investors**, **Weighted APY**, and **Active Tokens**.
3. In the left list, scan each token's status badge — **Active**, **Paused**, or **Winding Down**.
4. Select a token to populate the detail panel: supply, investor count, yield APY, and the distribution schedule, plus an investor-growth chart.

::: tip No tokens yet?
The empty state offers **Issue your first token**, which takes you to `/tokens/new`. See [Issue a token](/guide/issuer/issue-token).
:::

## Expected result

<ExpectedResult>
The aggregate strip shows your portfolio totals, and selecting a token fills the detail panel with its supply, investor count, APY, schedule, and an <em>investor-growth chart</em>.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| You see only an empty state | You have no tokens yet — click **Issue your first token** → [Issue a token](/guide/issuer/issue-token). |
| A token shows **Paused** | Investors can't buy until it's unpaused — publish NAV and unpause it. |
| Detail panel is blank | Select a token in the left list to populate it. |

→ Next: [Investor registry](/guide/issuer/investor-registry)
