---
title: Compliance dashboard
description: Review aggregate compliance posture — jurisdictions, eligibility, and gate config.
---

# Compliance dashboard

<TaskMeta time="~1 min" role="Issuer" needs="Approved issuer" />

> **What you'll do:** Review your aggregate compliance posture — jurisdiction mix, eligibility stats, and gate configuration.

## Before you begin

::: info Prerequisites
- You're an **approved issuer**.
:::

::: info Everything here is aggregate-only
The compliance dashboard shows aggregates — **individual balances stay encrypted**. There's nothing per-investor to reveal here.
:::

## Steps

1. Go to `/compliance`.
2. Read the **Investors by Jurisdiction** bar chart to see your geographic mix.
3. Check the stats strip: **Total Eligible**, **Ineligible**, **Expiring Soon**, and **Blocked**.
4. Review the panels: gate configuration (read-only — the edit control is **Coming soon**), the jurisdiction overview, and trusted issuers.

::: info Read-only
This is a read-only dashboard. Gate configuration display is informational; editing is **Coming soon**.
:::

## Expected result

<ExpectedResult>
You see the <strong>Investors by Jurisdiction</strong> chart, the eligibility stats strip, and the gate/jurisdiction/trusted-issuer panels — all <em>aggregate-only</em>, with individual balances kept encrypted.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| The edit gate-config control does nothing | Editing is **Coming soon** — the panel is read-only for now. |
| The jurisdiction chart looks empty | It populates as eligible investors with declared jurisdictions hold your tokens. |
| You expected per-investor detail | This dashboard is aggregate-only by design; individual balances stay encrypted. |

→ Next: back to the [Testing Guide overview](/guide/)
