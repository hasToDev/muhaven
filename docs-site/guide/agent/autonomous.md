---
title: Let the agent act autonomously
description: With a Scoped session, the agent can buy, sell, claim, reinvest, and rebalance without per-action prompts.
---

# Let the agent act autonomously

<TaskMeta time="~4 min" role="Any signed-in user" needs="A Scoped session granted (A3)" />

> **What you'll do:** Grant a **Scoped** session, then watch the agent execute a small action on-chain without prompting you per trade.

## Before you begin
::: important Requires a Scoped session
This flow only runs when you've granted a **Scoped** session — see [Set the agent's autonomy tier](/guide/agent/set-tier). Without one, these actions fall back to a Path-C deep-link you must approve with your passkey.
:::

## What the agent can do autonomously
- **Buy / Sell / Claim** — via MCP `muhaven.position.buy`, `muhaven.position.sell`, `muhaven.position.claim` (claim needs a concrete epoch/escrow id). With a live Scoped session these submit autonomously and return a tx hash; without one they fall back to a Path-C deep-link.
- **Auto-reinvest** — the agent can automatically claim matured yield and buy more of a token (opt-in).
- **Rebalance to targets** — ask **HavenBot** to "rebalance my portfolio to these targets". It uses the **Auto-rebalance** panel on `/portfolio`, then executes **one atomic transaction** (sells before buys) via your in-tab scoped session.

::: warning Two carve-outs to remember
- The standalone external MCP tool `muhaven.position.rebalance` is intentionally **not implemented** and returns **`not_implemented`**. Do rebalances through **HavenBot / the Portfolio panel**, not that tool.
- **`muhaven.cash.wrap` / `muhaven.cash.unwrap`** always go through a passkey **deep-link (Path C)** — never silent autonomous submission.
:::

## Steps
1. Grant a **Scoped** session ([A3](/guide/agent/set-tier)).
2. Ask the agent to make a **small buy** (or set up auto-reinvest, or a rebalance to targets).
3. Watch it execute — transactions take ~30–60s and gas is sponsored.
4. Verify the result in [Activity](/guide/investor/activity) and via `muhaven.read.activity`.

## Expected result
<ExpectedResult>
The agent executes <strong>without a per-action prompt</strong> and returns a <strong>tx hash</strong>. After ~30–60s the action appears in <a href="/guide/investor/activity">Activity</a> and in <code>muhaven.read.activity</code>.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| Action returns a deep-link instead of running | No live Scoped session — grant one in [A3](/guide/agent/set-tier). |
| `muhaven.position.rebalance` returns `not_implemented` | Expected — rebalance via HavenBot / the Portfolio panel instead. |
| `muhaven.cash.wrap` / `muhaven.cash.unwrap` asks for your passkey | Expected — those always use Path C, never autonomous submission. |
| You want to stop everything now | Use the [pause kill-switch](/guide/agent/pause). |

→ Next: [Approve an action via deep-link](/guide/agent/deep-link-confirm)
