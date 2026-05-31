---
title: Buy autonomously via MCP
description: With a Scoped session installed, ask your own LLM to buy an RWA position — it executes and returns a tx hash, no dashboard deep-link.
---

# Buy autonomously via MCP

<TaskMeta time="~3 min" role="Investor" needs="A Scoped session installed (M1+M2), some mhUSDC" />

> **What you'll do:** ask your own LLM to buy a small position in plain language — because the broker holds your Scoped key, it executes on-chain and returns a **tx hash**, with **no dashboard deep-link and no confirmation**.

## Before you begin
::: info Prerequisites
A **Scoped session** minted on the dashboard ([M1](/guide/mcp/arm-scoped)) and installed into the broker ([M2](/guide/mcp/install)), plus some **mhUSDC** to spend ([I3 · Deposit](/guide/investor/deposit)). Verify with `muhaven-broker doctor` — its signer should match your dashboard session.
:::

## Steps
1. In your host, type a plain-language buy — e.g. **"Buy $5 of CETES."**
2. Your LLM calls the MuHaven buy tool. With your Scoped key installed, the broker **signs and submits the trade autonomously** — no deep-link, no passkey prompt.
3. After ~30–60s (gas is sponsored) your LLM reports a **transaction hash**.
4. Verify: ask **"Show my recent activity"**, or open [Activity](/guide/investor/activity).

::: info Within your cap, on your key
The broker can only sign trades up to the **per-trade cap** and within the **TTL** you set when you minted the Scoped session — never your passkey, never beyond your policy. A request over the cap (or after the TTL lapses) falls back to a dashboard deep-link you approve by hand.
:::

## Expected result
<ExpectedResult>
The buy lands on-chain within ~30–60s and your LLM returns a <strong>tx hash</strong> —
<strong>no deep-link, no confirmation</strong>. It shows up when you ask <em>"show my recent
activity"</em>.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| Buy returns a dashboard deep-link instead of running | No live Scoped session installed — mint one ([M1](/guide/mcp/arm-scoped)) and confirm `muhaven-broker doctor`'s signer matches. |
| "exceeds the per-op cap" | The amount is above your per-trade cap — ask for a smaller amount, or raise the cap by re-minting the Scoped session ([M1](/guide/mcp/arm-scoped)). |
| Insufficient mhUSDC | Deposit more first ([I3](/guide/investor/deposit)); reveal your mhUSDC balance if a trade screen shows it locked ([I6](/guide/investor/reveal-balance)). |

→ Next: [Sell autonomously via MCP](/guide/mcp/sell)
