---
title: Arm Scoped autonomy on the dashboard
description: Mint a Scoped session on the dashboard first — the install step asks for this key so your own LLM can trade without a deep-link.
---

# Arm Scoped autonomy on the dashboard

<TaskMeta time="~3 min" role="Investor" needs="A MuHaven passkey wallet" />

> **What you'll do:** mint a **Scoped session** on the dashboard and copy its key. The MCP install step ([M2](/guide/mcp/install)) asks for this key, and it's what lets your own LLM buy and sell **without a dashboard deep-link**.

## Before you begin
::: info Do this before you install
The autonomy tier is set on the **dashboard only** — the MCP server can't change it. Minting the Scoped session here first means `muhaven-broker setup` can consume the key when you install, so your LLM trades autonomously from the very first run. Without this, MCP buys/sells fall back to a dashboard deep-link you approve by hand.
:::

## Steps
1. Sign in at [muhaven.app](https://muhaven.app) with your passkey (see [I1 · Sign in](/guide/investor/sign-in)).
2. Go to `/agent/policy/transition`.
3. Pick the **`Scoped autonomy`** tier.
4. Set your **per-trade cap** (max mhUSDC per trade — defaults to $100) and a **TTL** (how long the session is valid).
5. Click **Confirm transition** and **approve with your passkey**.
6. A **session-key reveal modal** opens. Click **Copy raw key** (under *Raw private key · advanced*) — that's the value you'll paste when the installer prompts in [M2](/guide/mcp/install). Keep it on your clipboard (or in a password manager) for the next step.

::: warning Copy the raw key for the install prompt
`muhaven-broker setup` asks you to *paste the session key* — it expects the **raw `0x…` key**, not the full command. Use **Copy raw key**. The modal's *Copy broker command* button (a one-paste `muhaven-broker update --session …`) is for rotating the key on a broker that's **already running** — handy later, but not what the first-time install prompt wants.
:::

::: info The key is minted on your device
The session key is generated **client-side** and never sent over the wire. The broker you install next gets time-boxed, capped signing rights — never your passkey.
:::

## Expected result
<ExpectedResult>
A <strong>live Scoped session</strong> exists on your account (shown by the session banner +
revoke zone on the policy page), and you've copied the <strong>raw session key</strong> ready
to paste during install.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| Reveal modal didn't mint a key | Cancel and reopen it; the key is generated locally, so retry on-device. |
| You closed the modal before copying | Re-opening the page mints a **fresh** key — just re-do the mint and copy the new raw key. |
| The cap or TTL won't accept your value | The per-trade cap must be at least **$1 mhUSDC**; pick a TTL from the offered options. |
| Want to lock it down later | **Revoke** on the policy page, or ask your agent to *"pause my agent"* — both block every write instantly. |

→ Next: [Install & set up the MCP server](/guide/mcp/install)
