---
title: Buy a position via MCP
description: Ask your own LLM to buy an RWA position; approve the returned dashboard deep-link with your passkey.
---

# Buy a position via MCP

<TaskMeta time="~3 min" role="Investor" needs="@muhaven/mcp logged in (M1), some mhUSDC" />

> **What you'll do:** ask your LLM to buy a small position — it proposes the buy and hands back a dashboard deep-link you approve with your passkey.

## Before you begin
::: info Prerequisites
The `@muhaven/mcp` server logged in ([M1](/guide/mcp/install)) and some **mhUSDC** to spend ([I3 · Deposit](/guide/investor/deposit)). Without a Scoped session, buys are proposed for your approval — for the autonomous path see [M5](/guide/mcp/autonomous).
:::

## Steps
1. In your host, type something like **"Buy 5 mhUSDC of CETES."**
2. Your LLM calls **`muhaven.position.buy`**.
3. The tool returns a **dashboard deep-link** (e.g. `muhaven.app/trade?mode=buy&…`). Open it.
4. A **ConfirmModal** mounts showing a cleartext preview. Review it, tap **Authorize**, and approve with your **passkey**.
5. The buy executes on-chain (~30–60s; gas is sponsored).
6. Verify it: ask **"Show my recent activity"** → `muhaven.read.activity`, or open [Activity](/guide/investor/activity).

::: important The agent proposes — you are the signer
Without a Scoped session, nothing executes until you approve the deep-link with your passkey. Your LLM never holds your key.
:::

## Expected result
<ExpectedResult>
<code>muhaven.position.buy</code> returns a <strong>dashboard deep-link</strong>; after you
<strong>Authorize</strong> it with your passkey the buy lands on-chain within ~30–60s and
shows up via <code>muhaven.read.activity</code>.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| Buy returns a deep-link instead of running | Expected without a Scoped session — approve the link with your passkey, or grant a Scoped session on the dashboard ([H3 · Set the autonomy tier](/guide/agent/set-tier)). |
| The deep-link preview doesn't match your request | Don't authorize — close it and re-ask for the correct amount/token. |
| Insufficient mhUSDC | Deposit more first ([I3](/guide/investor/deposit)); reveal your mhUSDC balance if the trade screen shows it locked ([I6](/guide/investor/reveal-balance)). |

→ Next: [Sell a position via MCP](/guide/mcp/sell)
