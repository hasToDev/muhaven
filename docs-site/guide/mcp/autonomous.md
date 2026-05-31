---
title: Autonomous execution via MCP
description: With a Scoped session granted, your LLM's buys, sells, and claims submit autonomously and return a tx hash.
---

# Autonomous execution via MCP

<TaskMeta time="~4 min" role="Investor" needs="A Scoped session granted (M5/H3), @muhaven/mcp logged in" />

> **What you'll do:** with a Scoped session active, ask your LLM for a small action — it submits autonomously and returns a tx hash, no per-trade prompt.

## Before you begin
::: important Requires a Scoped session
This only runs when you've armed a **Scoped** session on the dashboard ([H3 · Set the autonomy tier](/guide/agent/set-tier)). Without one, the same actions return a dashboard deep-link you approve with your passkey — the autonomous Scoped path is what removes that prompt.
:::

## What runs autonomously
- **Buy / Sell / Claim** — `muhaven.position.buy`, `muhaven.position.sell`, `muhaven.position.claim`. With a live Scoped session these submit autonomously and return a **tx hash**; without one they fall back to a dashboard deep-link.
- **Auto-reinvest** — the keyless **`muhaven-reinvest`** runner (ships with `@muhaven/mcp`) claims matured yield and reinvests it within your Scoped session and budget cap. Opt-in via `MUHAVEN_REINVEST_BUDGET_USD`; it never holds your passkey. See [/mcp/broker](/mcp/broker).

::: warning Two carve-outs
- `muhaven.position.rebalance` is intentionally **not implemented** (`not_implemented`) — rebalance through HavenBot / the Portfolio panel instead ([H4](/guide/agent/autonomous)).
- `muhaven.cash.wrap` / `muhaven.cash.unwrap` always use a passkey **dashboard deep-link** — never autonomous submission.
:::

## Steps
1. Arm a **Scoped** session ([M5](/guide/mcp/set-tier) / [H3](/guide/agent/set-tier)).
2. Ask your LLM for a **small buy** (or start `muhaven-reinvest`).
3. It executes — ~30–60s, gas sponsored — and returns a **tx hash**.
4. Verify via `muhaven.read.activity` or [Activity](/guide/investor/activity).

## Expected result
<ExpectedResult>
With a live Scoped session, your LLM's action executes <strong>without a per-action
prompt</strong> and returns a <strong>tx hash</strong>; it appears in
<code>muhaven.read.activity</code> within ~30–60s.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| Action returns a deep-link instead of running | No live Scoped session — arm one ([M5](/guide/mcp/set-tier) / [H3](/guide/agent/set-tier)). |
| `muhaven.position.rebalance` returns `not_implemented` | Expected — rebalance via HavenBot / the Portfolio panel ([H4](/guide/agent/autonomous)). |
| Want to stop everything now | Use the [pause kill-switch](/guide/mcp/pause). |

→ Next: [Pause / kill-switch via MCP](/guide/mcp/pause)
