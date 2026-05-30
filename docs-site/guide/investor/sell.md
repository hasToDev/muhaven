---
title: Sell a position
description: Redeem RWA shares for mhUSDC — instantly, or via the redemption queue when you exceed the cap.
---

# Sell a position

<TaskMeta time="~2 min" role="Investor" needs="a holding to sell" />

> **What you'll do:** Sell whole shares of an RWA token and receive `mhUSDC`, either instantly or through the redemption queue.

## Before you begin

::: tip
Sell amounts are **whole shares** (integers). Reveal your holding balance first so the app knows how many shares you have.
:::

## Steps

1. Go to `/trade` and set the toggle to **Sell** (or open `/trade?mode=sell` directly).
2. Reveal your holding balance with **Reveal** / the Eye icon.
3. Enter the number of shares, or use **Half** / **Max** to quick-fill.
4. Check the **instant cap remaining** shown on the page. If your sell exceeds it, it escalates to the redemption queue.
5. Click **Sell {SYMBOL}** — or **Sell {SYMBOL} (queued)** when escalation is likely. Internally the app approves the RWA token (once), then runs **Encrypt** and **Redeem**.

## Expected result

<ExpectedResult>
One of two outcomes:
<ul>
<li><strong>Instant:</strong> a <strong>"Redemption confirmed"</strong> card — shares burned and `mhUSDC` paid out in one transaction.</li>
<li><strong>Queued:</strong> an <strong>"Added to redemption queue"</strong> card with a request-ID badge — it settles a later epoch.</li>
</ul>
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| The amount field rejects your value | Sells must be **whole shares** (integers) — drop any decimals. |
| Your sell was queued, not instant | You exceeded the instant cap — claim it later via the [redemption queue](/guide/investor/redemption-queue). |
| You can't tell if it settled | Verify the transaction in [Activity](/guide/investor/activity). |

→ Next: [Claim yield](/guide/investor/claim-yield)
