---
title: Sell autonomously via MCP
description: With a Scoped session installed, ask your own LLM to sell a position — it submits autonomously and returns a tx hash, no deep-link.
---

# Sell autonomously via MCP

<TaskMeta time="~3 min" role="Investor" needs="A Scoped session installed (M1+M2), an open position" />

> **What you'll do:** ask your own LLM to sell part of a holding in plain language — the broker submits it autonomously with your Scoped key and you verify the settlement, **no dashboard deep-link**.

## Before you begin
::: info Prerequisites
A **Scoped session** installed in the broker ([M1](/guide/mcp/arm-scoped) + [M2](/guide/mcp/install)) and an open position to sell ([I5 · Buy](/guide/investor/buy)). For an end-to-end autonomous round-trip, do [M4 · Buy autonomously](/guide/mcp/buy) first.
:::

## Steps
1. In your host, type **"Sell 2 shares of CETES."**
2. Your LLM calls the MuHaven sell tool; the broker **signs and submits autonomously** and returns a **tx hash** — no deep-link, no passkey prompt.
3. A sell within the token's per-epoch instant cap settles **instantly**; a larger sell is **queued** and settles in a later epoch — claim it later ([I9 · Redemption-queue claim](/guide/investor/redemption-queue)).
4. Verify: ask **"Show my recent activity"**, or open [Activity](/guide/investor/activity).

::: warning Over-sell is clamped
If you ask to sell more than you hold, the contract clamps to your actual balance — you sell your full position, not a phantom amount. See [I7 · Sell](/guide/investor/sell).
:::

::: tip Two carve-outs to remember
- **Portfolio rebalance** isn't an autonomous MCP tool — ask **HavenBot** to rebalance to targets, or use the **Auto-rebalance** panel on `/portfolio` ([H4 · Buy & sell with HavenBot](/guide/agent/autonomous)).
- **Converting USDC ↔ mhUSDC** (deposit/withdraw) always uses a passkey **dashboard deep-link** — never autonomous submission.
:::

## Expected result
<ExpectedResult>
The sell either settles <strong>instantly</strong> or lands in the <strong>redemption
queue</strong>, and your LLM returns a <strong>tx hash</strong> — <strong>no deep-link</strong>.
It shows up when you ask <em>"show my recent activity"</em>.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| Sell returns a dashboard deep-link instead of running | No live Scoped session installed — mint one ([M1](/guide/mcp/arm-scoped)) and confirm `muhaven-broker doctor`'s signer matches. |
| Sale was queued, not instant | The amount exceeded the per-epoch instant cap — settle the queued portion later ([I9](/guide/investor/redemption-queue)). |
| You asked to sell more than you hold | The sell clamps to your full balance — not an error. See [I7](/guide/investor/sell). |

→ Next: [Reference appendix](/guide/reference)
