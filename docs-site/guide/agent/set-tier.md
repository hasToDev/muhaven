---
title: Set the agent's autonomy tier
description: Choose how much rope the agent gets — from read-only Advisory to autonomous Scoped.
---

# Set the agent's autonomy tier

<TaskMeta time="~3 min" role="Any signed-in user" needs="Signed in with your passkey" />

> **What you'll do:** Pick an autonomy tier for the agent — and learn how stepping up to **Scoped** mints a session key entirely on your device.

## Before you begin
::: info Prerequisites
Be signed in with your passkey. You decide how much rope the agent gets, and you can change it anytime.
:::

## The four tiers
- **Advisory** — read-only. Every write needs a fresh passkey signature.
- **Confirm-per-action** — the agent proposes; you confirm each write.
- **Policy-bound** — the agent writes within an allowlist plus spend caps.
- **Scoped** — autonomous (Path D): buys/sells within a per-action ceiling and a time limit, with no per-trade prompt.

## Steps
1. Go to `/agent/policy/transition` (also reachable from a HavenBot deep-link).
2. Pick a tier.
3. **Stepping down** (toward Advisory) applies **immediately**.
4. **Stepping up** requires a confirmation token (≈5-min TTL) — click **Confirm transition**.
5. If you choose **Scoped**, a **session-key reveal modal** opens and mints a short-lived ephemeral key.

::: important The Scoped key is minted on your device
The ephemeral session key is generated **client-side** and is **never sent over the wire**. The agent gets time-boxed, capped signing rights — not your passkey.
:::

::: tip MCP equivalent
The same change is available as the MCP tool `muhaven.policy.set_tier`.
:::

## Expected result
<ExpectedResult>
The active tier updates. Stepping <em>down</em> takes effect <strong>immediately</strong>; stepping <em>up</em> only takes effect after you click <strong>Confirm transition</strong> within the token's TTL. Choosing Scoped leaves you with a freshly minted, time-limited session key.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| "Transition expired" when stepping up | The ≈5-min confirmation token lapsed — start the step-up again. |
| Scoped modal didn't mint a key | Cancel and reopen the modal; the key is generated locally, so retry on-device. |
| Want to lock the agent down fast | Step down to **Advisory** — it applies instantly. |

→ Next: [Let the agent act autonomously](/guide/agent/autonomous)
