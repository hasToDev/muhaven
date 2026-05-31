---
title: Buy & sell autonomously
description: With a Scoped session live, ask HavenBot to buy and sell in plain language — it executes on-chain with no per-trade confirmation.
---

# Buy & sell autonomously

<TaskMeta time="~4 min" role="Any signed-in user" needs="A Scoped session armed (H3)" />

> **What you'll do:** with a live Scoped session, tell HavenBot to **buy** and then **sell** in plain language and watch each trade land on-chain — no confirmation modal.

## Before you begin
::: info Requires a Scoped session
This flow only runs once you've armed a **Scoped** session — see [H3 · Arm Scoped autonomy](/guide/agent/set-tier). Without one, the same requests fall back to a dashboard deep-link you approve with your passkey.
:::

## Buy — no confirmation

1. Open **Agent** (`/agent`).
2. Type a plain-language buy, e.g. **"Buy $5 of CETES."**
3. HavenBot executes it **immediately** — no confirmation card, because your Scoped session authorizes trades up to your per-trade cap. After ~30–60s (gas is sponsored) it replies with a **transaction hash**.

## Sell — no confirmation

1. In the same chat, type **"Sell 2 shares of CETES."**
2. HavenBot submits the sell autonomously and returns a **tx hash**. A sell within the token's per-epoch instant cap settles immediately; a larger sell is queued and settles in a later epoch (claim it later — see [I9 · Redemption-queue claim](/guide/investor/redemption-queue)).

::: tip Advisory vs Scoped — the difference you just saw
On **Advisory** (or with no session), every buy/sell surfaces a confirmation you approve with your passkey. With a **Scoped** session live, HavenBot signs within your cap and TTL — that's why neither trade above asked you to confirm.
:::

## More it can do autonomously
- **Auto-reinvest** — HavenBot can automatically claim matured yield and buy more of the same token (opt-in on the policy page).
- **Rebalance to targets** — ask HavenBot to *"rebalance my portfolio to these targets"*. It uses the **Auto-rebalance** panel on `/portfolio`, then executes **one atomic transaction** (sells before buys) within your Scoped session.

## Verify
1. Open [Activity](/guide/investor/activity), or ask HavenBot *"show my recent activity"*.
2. Your buy and sell appear as settled rows within ~30–60s.

::: tip Stop it anytime — just ask
To halt autonomous execution, tell HavenBot *"pause my agent"* — that blocks every write instantly. You can also revoke the session from the dashboard or via Telegram. To resume, pick a tier again on the dashboard and confirm with your passkey.
:::

## Expected result
<ExpectedResult>
Both the buy and the sell execute <strong>without a per-action prompt</strong> and return a
<strong>tx hash</strong>. After ~30–60s they appear in <a href="/guide/investor/activity">Activity</a>.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| HavenBot returns a deep-link instead of trading | No live Scoped session — arm one in [H3 · Arm Scoped autonomy](/guide/agent/set-tier). |
| A sell was queued, not instant | The amount exceeded the per-epoch instant cap — settle the queued portion later ([I9](/guide/investor/redemption-queue)). |
| HavenBot asks your passkey for a deposit/withdraw | Expected — converting USDC ↔ mhUSDC always uses a dashboard deep-link, never autonomous submission. |
| You want to stop everything now | Ask HavenBot *"pause my agent"* — it blocks every write instantly. You can also revoke the session from the dashboard or via Telegram. |

→ Next: [Arm Scoped autonomy on the dashboard (MCP)](/guide/mcp/arm-scoped)
