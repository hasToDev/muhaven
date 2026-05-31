---
title: Buy & sell with HavenBot
description: Ask HavenBot to buy and sell in plain language — it previews each trade for you to authorize, with the device passkey needed only once per session.
---

# Buy & sell with HavenBot

<TaskMeta time="~4 min" role="Any signed-in user" needs="A Scoped session armed (H3), some mhUSDC" />

> **What you'll do:** tell HavenBot to **buy** and then **sell** in plain language. HavenBot previews each trade in a confirmation card you authorize — and after a one-time device passkey, authorizing is a single tap.

## Before you begin
::: info How HavenBot signs
HavenBot **proposes** each buy/sell and shows you a **confirmation card** with a cleartext preview to **Authorize**. The **first** action you authorize in a browser session also asks for your **device passkey once** (to authorize an in-tab signing session); after that, authorizing is **instant — no passkey prompt** — but you still tap to confirm each trade. So HavenBot is *one-tap-per-trade*, not hands-off. For genuinely prompt-free per-trade trading, use the [MCP track](/guide/mcp/arm-scoped) (the broker holds your Scoped key and signs server-side).
:::

## Buy

1. Open **Agent** (`/agent`).
2. Type a plain-language buy, e.g. **"Buy $5 of CETES."**
3. HavenBot replies with a **confirmation card** (the cleartext amount + token). Review it and click **Authorize**.
4. The first authorize in this browser session triggers your **passkey once**; later ones are instant. After ~30–60s (gas is sponsored) HavenBot returns a **transaction hash**.

## Sell

1. In the same chat, type **"Sell 2 shares of CETES."**
2. Authorize the confirmation card. The sell settles **instantly** within the token's per-epoch instant cap; a larger sell is **queued** and settles in a later epoch (claim it later — see [I9 · Redemption-queue claim](/guide/investor/redemption-queue)).

::: tip Want truly hands-off? Use these two
- **Auto-reinvest** — HavenBot automatically claims matured yield and buys more of the same token, **with no per-trade confirmation** (opt-in on the policy page; runs on your Scoped session).
- **Rebalance to targets** — ask HavenBot to *"rebalance my portfolio to these targets"*. It executes **one atomic transaction** (sells before buys) on your Scoped session — a single authorize for the whole rebalance.

For prompt-free *individual* buys and sells, the [MCP broker](/guide/mcp/buy) is the path — it holds your Scoped key and signs each trade server-side with no card and no passkey.
:::

## Verify
1. Open [Activity](/guide/investor/activity), or ask HavenBot *"show my recent activity"*.
2. Your buy and sell appear as settled rows within ~30–60s.

::: tip Stop anytime — just ask
Tell HavenBot *"pause my agent"* — it blocks every write instantly. You can also revoke the session from the dashboard or via Telegram. To resume, pick a tier again on the dashboard and confirm with your passkey.
:::

## Expected result
<ExpectedResult>
Each buy and sell is <strong>previewed in a confirmation card you authorize</strong> (device
passkey only the first time), then lands a <strong>tx hash</strong> on-chain in ~30–60s and
shows up in <a href="/guide/investor/activity">Activity</a>.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| Every authorize asks for the device passkey (not just the first) | The in-tab signing session isn't persisting (e.g. you reloaded or switched tabs between trades) — each fresh tab re-authorizes once. |
| A sell was queued, not instant | The amount exceeded the per-epoch instant cap — settle the queued portion later ([I9](/guide/investor/redemption-queue)). |
| HavenBot asks your passkey for a deposit/withdraw | Expected — converting USDC ↔ mhUSDC always uses a dashboard deep-link, never silent submission. |
| You want zero confirmation per trade | Drive trades from the [MCP broker](/guide/mcp/buy) instead — it signs server-side with no card or passkey. |

→ Next: [Arm Scoped autonomy on the dashboard (MCP)](/guide/mcp/arm-scoped)
