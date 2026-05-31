---
title: Arm Scoped autonomy
description: Mint a Scoped session on the dashboard to power prompt-free trading via the MCP broker and HavenBot's hands-off flows.
---

# Arm Scoped autonomy

<TaskMeta time="~3 min" role="Any signed-in user" needs="Signed in with your passkey" />

> **What you'll do:** mint a **Scoped session** on the dashboard — the signing grant that powers the **MCP broker's** prompt-free trading and HavenBot's hands-off flows (auto-reinvest, rebalance), within a cap and time limit you set.

## Before you begin
::: info Prerequisites
Be signed in with your passkey. You decide how much rope the agent gets, and you can change or revoke it anytime.
:::

This is **the enabling step** for autonomous trading. With a Scoped session live, the
[MCP broker](/guide/mcp/arm-scoped) trades **with no prompt at all**, and **HavenBot
auto-executes your buys and sells** ([H4](/guide/agent/autonomous)) — the confirmation card
flashes and self-submits, no click, no passkey (device passkey only the first time per
browser session) — plus hands-off **auto-reinvest** and **rebalance**.

## How much rope you can give the agent

You pick one of four tiers:

- **Advisory** — read-only. Every write needs a fresh passkey signature.
- **Confirm per action** — the agent proposes; you confirm each write.
- **Policy-bound** — a designed tier where the agent would write within an allowlist plus spend caps. Its auto-signing engine is built but **not enabled in any current deployment**, so use **Scoped autonomy** (below) for live hands-off execution.
- **Scoped autonomy** — the **live autonomous tier**. Grants capped, time-bounded signing within a **per-trade cap** and **TTL**. The **MCP broker** then trades with **no prompt**, and **HavenBot auto-executes your buys/sells** (card flashes, no click/passkey) plus hands-off auto-reinvest + rebalance.

## Steps
1. Go to `/agent/policy/transition` (you can also ask HavenBot to *"open my agent settings"*).
2. Leave the **surface** on **MCP / Broker** (the default). Scoped autonomy is minted on that surface, and **HavenBot reuses the same session** — so this one Scoped session powers both. If you switch the surface to HavenBot, the Scoped tier is intentionally disabled (with a hint to switch back).
3. **Pick the `Scoped autonomy` tier** directly — there's no ladder to climb; any tier is one confirming tap away.
4. Set your **per-trade cap** (the maximum mhUSDC the agent can spend on a single trade — defaults to $100) and a **TTL** (how long the session stays valid).
5. Click **Confirm transition**, then **approve with your passkey**.
6. A **session-key reveal modal** opens. It mints a short-lived signing key **on your device** and surfaces it. For HavenBot in this same browser, you're done — the session is already active. (If you also run the MCP server, this is the key you'll hand to the broker — see [M1 · Arm Scoped autonomy on the dashboard](/guide/mcp/arm-scoped).)

::: info The Scoped key is minted on your device
The session key is generated **client-side** and is **never sent over the wire**. HavenBot gets time-boxed, capped signing rights — not your passkey.
:::

::: tip You can revoke it anytime
The same page shows a **Revoke** zone once a session is live, and you can lock the agent down instantly by asking HavenBot to *"pause my agent"*. Revoking or pausing blocks every write at once.
:::

## Expected result
<ExpectedResult>
After your passkey confirms, a <strong>live Scoped session</strong> exists — shown by the
session banner and the revoke zone on the policy page. Now <strong>HavenBot auto-executes
your buys/sells</strong> (card flashes, no click/passkey) and the MCP broker trades
prompt-free — both up to your per-trade cap until the TTL expires.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| Scoped modal didn't mint a key | Cancel and reopen the modal; the key is generated locally, so retry on-device. |
| Want to lock the agent down fast | Ask HavenBot to *"pause my agent"*, or hit **Revoke** on the policy page — both block every write instantly. |
| Want to resume after pausing | Pick a tier again on the dashboard; your passkey installs a fresh session. |
| The cap or TTL won't accept your value | The per-trade cap must be at least **$1 mhUSDC** and the TTL must be one of the offered options. |

→ Next: [Buy & sell with HavenBot](/guide/agent/autonomous)
