---
title: Sell a position via MCP
description: Ask your own LLM to sell a position — instant or queued — and verify it on your activity feed.
---

# Sell a position via MCP

<TaskMeta time="~3 min" role="Investor" needs="@muhaven/mcp logged in (M1), an open position" />

> **What you'll do:** ask your LLM to sell part of a holding — it proposes the sell, you approve the dashboard deep-link, and you verify the settlement.

## Before you begin
::: info Prerequisites
The `@muhaven/mcp` server logged in ([M1](/guide/mcp/install)) and an open position to sell ([I5 · Buy](/guide/investor/buy)). Without a Scoped session, sells are proposed for your approval — for the autonomous path see [M6](/guide/mcp/autonomous).
:::

## Steps
1. In your host, type **"Sell 2 shares of TBILL1."**
2. Your LLM calls **`muhaven.position.sell`** and returns a **dashboard deep-link**.
3. Open it, review the cleartext preview, tap **Authorize**, and approve with your **passkey**.
4. The sell settles **instantly** when it's within the token's per-epoch instant cap; an over-cap sell is **queued** and settles in a later epoch — claim it later ([I9 · Redemption-queue claim](/guide/investor/redemption-queue)).
5. Verify: ask **"Show my recent activity"** → `muhaven.read.activity`.

::: warning Over-sell is clamped
If you ask to sell more than you hold, the contract clamps to your actual balance — you sell your full position, not a phantom amount. See [I7 · Sell](/guide/investor/sell).
:::

## Expected result
<ExpectedResult>
<code>muhaven.position.sell</code> returns a <strong>dashboard deep-link</strong>; after you
approve it with your passkey the sell either settles <strong>instantly</strong> or lands in
the <strong>redemption queue</strong>, visible via <code>muhaven.read.activity</code>.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| Sell returns a deep-link instead of running | Expected without a Scoped session — approve it, or grant a Scoped session ([M5](/guide/mcp/set-tier)). |
| Sale was queued, not instant | The amount exceeded the per-epoch instant cap — settle the queued portion later ([I9](/guide/investor/redemption-queue)). |
| You asked to sell more than you hold | The sell clamps to your full balance — not an error. See [I7](/guide/investor/sell). |

→ Next: [Set the autonomy tier via MCP](/guide/mcp/set-tier)
