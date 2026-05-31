---
title: Browse the marketplace
description: Explore confidential RWA tokens, filter by asset class, and open a token's detail page.
---

# Browse the marketplace

<TaskMeta time="~2 min" role="Anyone" needs="nothing — browsing is read-only" />

> **What you'll do:** Browse the confidential RWA marketplace and open a token's detail page to see its yield, NAV, and supply.

## Before you begin

::: info
Browsing is read-only and needs no sign-in. KYC is only enforced when you actually trade.
:::

## Steps

1. Go to `/marketplace`. The page header reads **Confidential RWA marketplace**.
2. Filter the list: type in the **Search tokens…** box, tap an asset-class filter pill, or use the yield-bearing toggle.
3. Click any token card to open its detail page at `/marketplace/:ticker` (for example `/marketplace/CETES`).
4. On the detail page, review the APY, NAV, supply, jurisdiction, and the NAV trend chart.
5. Use **Back to marketplace** to return, or the buy CTA to route to `/trade?token=<ticker>`.

## Expected result

<ExpectedResult>
A token detail page opens showing its APY, NAV, supply, jurisdiction, and a NAV trend chart, with a working <strong>Back to marketplace</strong> link.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| A token shows **Winding down — view only** | That token is sell-only — you can't open a new position in it. |
| The buy CTA is disabled with **Not yet listed on-chain** | That token isn't tradable yet; pick another. |

→ Next: [Buy an RWA position](/guide/investor/buy)
