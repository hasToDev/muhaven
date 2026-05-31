---
title: Arm Scoped autonomy
description: Mint a Scoped session on the dashboard so HavenBot can buy and sell for you without a per-trade prompt.
---

# Arm Scoped autonomy

<TaskMeta time="~3 min" role="Any signed-in user" needs="Signed in with your passkey" />

> **What you'll do:** mint a **Scoped session** on the dashboard — the one step that lets HavenBot buy and sell on your behalf without asking you to confirm each trade.

## Before you begin
::: info Prerequisites
Be signed in with your passkey. You decide how much rope the agent gets, and you can change or revoke it anytime.
:::

This is **the enabling step** for autonomous trading. Once a Scoped session is live, the
next page ([H4 · Buy & sell autonomously](/guide/agent/autonomous)) shows HavenBot executing
real trades from plain-language requests — no confirmation modal per trade.

## How much rope you can give the agent

You pick one of four tiers:

- **Advisory** — read-only. Every write needs a fresh passkey signature.
- **Confirm per action** — the agent proposes; you confirm each write.
- **Policy-bound** — the agent writes within an allowlist plus spend caps.
- **Scoped autonomy** — autonomous buys & sells within a **per-trade cap** and a **time limit (TTL)**, with **no per-trade prompt**. This is the one that unlocks hands-off trading.

## Steps
1. Go to `/agent/policy/transition` (you can also ask HavenBot to *"open my agent settings"*).
2. **Pick the `Scoped autonomy` tier** directly — there's no ladder to climb; any tier is one confirming tap away.
3. Set your **per-trade cap** (the maximum mhUSDC the agent can spend on a single trade — defaults to $100) and a **TTL** (how long the session stays valid).
4. Click **Confirm transition**, then **approve with your passkey**.
5. A **session-key reveal modal** opens. It mints a short-lived signing key **on your device** and surfaces it. For HavenBot in this same browser, you're done — the session is already active. (If you also run the MCP server, this is the key you'll hand to the broker — see [M1 · Arm Scoped autonomy on the dashboard](/guide/mcp/arm-scoped).)

::: info The Scoped key is minted on your device
The session key is generated **client-side** and is **never sent over the wire**. HavenBot gets time-boxed, capped signing rights — not your passkey.
:::

::: tip You can revoke it anytime
The same page shows a **Revoke** zone once a session is live, and you can lock the agent down instantly by asking HavenBot to *"pause my agent"*. Revoking or pausing blocks every write at once.
:::

## Expected result
<ExpectedResult>
After your passkey confirms, a <strong>live Scoped session</strong> exists — shown by the
session banner and the revoke zone on the policy page. HavenBot can now buy and sell up to
your per-trade cap, until the TTL expires, without prompting you each time.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| Scoped modal didn't mint a key | Cancel and reopen the modal; the key is generated locally, so retry on-device. |
| Want to lock the agent down fast | Ask HavenBot to *"pause my agent"*, or hit **Revoke** on the policy page — both block every write instantly. |
| Want to resume after pausing | Pick a tier again on the dashboard; your passkey installs a fresh session. |
| The cap or TTL won't accept your value | The per-trade cap must be at least **$1 mhUSDC** and the TTL must be one of the offered options. |

→ Next: [Buy & sell autonomously](/guide/agent/autonomous)
