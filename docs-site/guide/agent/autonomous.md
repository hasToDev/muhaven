---
title: Buy & sell with HavenBot
description: Ask HavenBot to buy and sell in plain language — it previews each trade for you to authorize, with the device passkey needed only once per session.
---

# Buy & sell with HavenBot

<TaskMeta time="~4 min" role="Any signed-in user" needs="A Scoped session armed (H3), some mhUSDC" />

> **What you'll do:** tell HavenBot to **buy** and then **sell** in plain language. HavenBot previews each trade in a confirmation card you authorize — and after a one-time device passkey, authorizing is a single tap.

## Before you begin
::: info How HavenBot signs with a live Scoped session
With a **live Scoped session** ([H3](/guide/agent/set-tier)), HavenBot **auto-executes** your buys and sells: the confirmation card appears **briefly and submits itself** — **no click, no passkey** (the device passkey is needed only once per browser session, the first time). The card still flashes so you can see what ran, and every trade is recorded in the audit log. **Without** a live Scoped session (or after it expires), HavenBot falls back to a **manual one-tap** confirmation. Either way the trade stays within your per-trade cap.
:::

## Buy

1. Open **Agent** (`/agent`).
2. Type a plain-language buy, e.g. **"Buy $5 of CETES."**
3. With a live Scoped session, HavenBot **submits it automatically** — the card flashes and self-authorizes, no click. After ~30–60s (gas is sponsored) HavenBot returns a **transaction hash**. (No session? You'll tap **Authorize** once instead.)

## Sell

1. In the same chat, type **"Sell 2 shares of CETES."**
2. With a live Scoped session it submits automatically (same flash-and-go). The sell settles **instantly** within the token's per-epoch instant cap; a larger sell is **queued** and settles in a later epoch (claim it later — see [I9 · Redemption-queue claim](/guide/investor/redemption-queue)).

::: tip Even more hands-off
- **Auto-reinvest** — HavenBot automatically claims matured yield and buys more of the same token, with **no card at all** (opt-in on the policy page; runs on your Scoped session).
- **Rebalance to targets** — ask HavenBot to *"rebalance my portfolio to these targets"*. It executes **one atomic transaction** (sells before buys) on your Scoped session.

Prefer a fully headless setup (e.g. from your own LLM/terminal)? The [MCP broker](/guide/mcp/buy) holds your Scoped key and signs each trade server-side — no dashboard tab open at all.
:::

## Verify
1. Open [Activity](/guide/investor/activity), or ask HavenBot *"show my recent activity"*.
2. Your buy and sell appear as settled rows within ~30–60s.

::: tip Stop anytime — just ask
Tell HavenBot *"pause my agent"* — it blocks every write instantly. You can also revoke the session from the dashboard or via Telegram. To resume, pick a tier again on the dashboard and confirm with your passkey.
:::

## Expected result
<ExpectedResult>
With a live Scoped session, each buy and sell <strong>self-authorizes</strong> (the card flashes,
no click, no passkey after the one-time first sign), lands a <strong>tx hash</strong> on-chain in
~30–60s, and shows up in <a href="/guide/investor/activity">Activity</a>.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| HavenBot shows a card you must tap (not auto) | No live Scoped session — arm one in [H3 · Arm Scoped autonomy](/guide/agent/set-tier) (or it expired — re-arm). |
| The first trade asked for the device passkey | Expected — the in-tab signing session authorizes once per browser session; later trades are silent. A fresh tab re-authorizes once. |
| A sell was queued, not instant | The amount exceeded the per-epoch instant cap — settle the queued portion later ([I9](/guide/investor/redemption-queue)). |
| HavenBot asks your passkey for a deposit/withdraw | Expected — converting USDC ↔ mhUSDC always uses a dashboard deep-link, never silent submission. |

→ Next: [Arm Scoped autonomy on the dashboard (MCP)](/guide/mcp/arm-scoped)
