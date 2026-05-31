---
title: Set the autonomy tier via MCP
description: Change the agent's autonomy tier from your own LLM with the two-step confirm-token flow.
---

# Set the autonomy tier via MCP

<TaskMeta time="~3 min" role="Investor" needs="@muhaven/mcp logged in (M1)" />

> **What you'll do:** change the agent's autonomy tier from your own LLM using `muhaven.policy.set_tier`, completing the confirm-token step with your passkey on the dashboard.

## Before you begin
::: info Prerequisites
The `@muhaven/mcp` server logged in ([M1](/guide/mcp/install)). This is the MCP equivalent of the in-dashboard flow [H3 · Set the autonomy tier](/guide/agent/set-tier) — the same four tiers (Advisory, Confirm per action, Policy-bound, Scoped autonomy).
:::

## Steps
1. In your host, type **"Set my autonomy tier to Policy-bound."** (or another tier).
2. Your LLM calls **`muhaven.policy.set_tier`**.
3. **Stepping down** (toward Advisory) applies immediately.
4. **Stepping up** returns a **confirm token** (≈5-min TTL) plus a dashboard link — open it and **passkey-sign the transition** to apply it.

::: important Scoped autonomy is armed from the dashboard
`set_tier` can request Scoped, but the **Scoped session key is minted on your device** via the dashboard's session-key reveal modal — not over MCP. Arm Scoped on the dashboard ([H3](/guide/agent/set-tier)); the key never crosses the wire.
:::

## Expected result
<ExpectedResult>
<code>muhaven.policy.set_tier</code> updates the tier. Stepping <em>down</em> takes effect
immediately; stepping <em>up</em> only applies after you passkey-sign the returned confirm
token on the dashboard within its TTL.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| "Transition expired" when stepping up | The ≈5-min confirm token lapsed — re-run `muhaven.policy.set_tier`. |
| Scoped didn't actually arm | Scoped is armed on the dashboard (the key is device-minted) — open [H3](/guide/agent/set-tier) and complete the session-key reveal. |
| Want to lock the agent down fast | Ask for **Advisory** — it applies instantly. |

→ Next: [Autonomous execution via MCP](/guide/mcp/autonomous)
