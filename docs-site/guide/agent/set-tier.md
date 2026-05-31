---
title: Set the agent's autonomy tier
description: Choose how much rope the agent gets — from read-only Advisory to autonomous Scoped.
---

# Set the agent's autonomy tier

<TaskMeta time="~3 min" role="Any signed-in user" needs="Signed in with your passkey" />

> **What you'll do:** Pick an autonomy tier for the agent — and learn how choosing **Scoped** mints a session key entirely on your device.

## Before you begin
::: info Prerequisites
Be signed in with your passkey. You decide how much rope the agent gets, and you can change it anytime.
:::

## The four tiers
- **Advisory** — read-only. Every write needs a fresh passkey signature.
- **Confirm per action** — the agent proposes; you confirm each write.
- **Policy-bound** — the agent writes within an allowlist plus spend caps.
- **Scoped autonomy** — autonomous execution with a Scoped session: buys/sells within a per-action ceiling and a time limit, with no per-trade prompt.

## Steps
1. Go to `/agent/policy/transition` (the dashboard tier picker; you can also ask HavenBot to *"open my agent settings"*).
2. **Pick any tier directly** — there's no ladder to climb and no step-up/step-down sequence. Select the tier you want.
3. Your **passkey confirms the change**.
4. If you choose **Scoped**, a **session-key reveal modal** opens and mints a short-lived ephemeral key.

::: important The autonomy tier is set on the dashboard only
You set your tier here, on the dashboard — it can't be changed from MCP. Your own LLM (MCP) acts *within* the Scoped session you grant here; it doesn't pick the tier.
:::

::: important The Scoped key is minted on your device
The ephemeral session key is generated **client-side** and is **never sent over the wire**. The agent gets time-boxed, capped signing rights — not your passkey.
:::

## Expected result
<ExpectedResult>
The active tier updates as soon as your passkey confirms the change — there's no step-up/step-down ladder. Choosing Scoped leaves you with a freshly minted, time-limited session key.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| Scoped modal didn't mint a key | Cancel and reopen the modal; the key is generated locally, so retry on-device. |
| Want to lock the agent down fast | Pick **Paused** — it blocks every write instantly (the kill-switch). |
| Want to resume after pausing | Pick any tier again; your passkey installs a fresh session key. |

→ Next: [Let the agent act autonomously](/guide/agent/autonomous)
