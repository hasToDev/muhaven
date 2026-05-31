---
title: Tiered autonomy
description: One dial that controls how much the agent can do without asking you — from "sign everything yourself" to "a bounded session key acts for you."
---

# Tiered autonomy

## The one idea

Tiered autonomy is a single dial with one question on it: **when the agent wants to send a transaction, who signs it?**

At one end, *you* sign every action with your passkey — the agent can only advise. At the other end, a **session key** with a spending ceiling signs for you, so the agent can act without interrupting you. The tiers in between are the steps along that dial.

Two things are true at every tier:

- **The agent never sees your balances.** Tier choice is about *signing*, not *privacy* — your amounts stay encrypted regardless of tier.
- **You choose your own tier.** There is no automatic promotion; you pick the tier and confirm the change yourself.

::: warning Development status — read this first
Parts of the design on this page are not yet fully wired. The **live, working autonomous path is Scoped autonomy** (a bounded session key + the broker daemon). **Policy-bound**'s encrypted-threshold auto-signing engine is *built but disabled in every deployment*, the "tier ladder" is *not enforced* (you choose your tier freely), and on-chain KYC runs in **dev mode**. The exact list is in [What's bypassed during development](#what-s-bypassed-during-development).
:::

## The tiers at a glance

| Tier | Who signs each write | What you do per action | Status today |
|---|---|---|---|
| **Advisory** | You — a fresh passkey signature every time | Approve every action with WebAuthn | ✅ Live |
| **Confirm per action** | A session key, *after* you confirm | Tap "confirm" on each proposed action | ✅ Live |
| **Policy-bound** | *Designed:* a risk engine, within your caps | Configure your call-allowlist + spend caps | ⚠️ Partially wired — see below |
| **Scoped autonomy** | A bounded session key — no prompt | Set a per-trade cap + expiry **once** | ✅ Live — the real autonomous tier |
| **Paused** | Nobody — all writes blocked | Nothing (this is the kill-switch) | ✅ Live |

The dial runs **Advisory → Confirm per action → Policy-bound → Scoped autonomy**, with **Paused** reachable from anywhere via [`/pause`](/policy/pause).

## How you set your tier

Set your tier yourself on the dashboard at **`/agent/policy/transition`** (the tier picker). You can **pick any tier directly** — there is no ladder to climb and no step-up/step-down sequence to follow. Select the tier you want, and your **passkey confirms the change**. Resuming from **Paused** likewise just needs your passkey (it reinstalls a fresh session key).

## Advisory — the default

> Agent can read your portfolio and propose actions. Every write requires a fresh passkey signature.

The agent reads and advises. When it proposes a write, a ConfirmModal opens with a cleartext preview and you sign with WebAuthn (Touch ID / Windows Hello / hardware key). Nothing moves without that signature.

**When to use:** getting started, after a long break, or any time you want to approve every action yourself.
**Trade-off:** highest friction, highest assurance — every action is single-signed by you.

## Confirm per action — the daily-driver tier

> Agent proposes; a dashboard / Telegram prompt asks you to confirm each write before it submits.

Your MuHaven wallet installs a narrowly-scoped **session key**:

- **Target:** only MuHaven contracts.
- **Selector allowlist:** only MuHaven SDK functions.
- **Value cap** per call, and an optional total cap per session.
- **Expiry (TTL):** the session key is valid until it expires (default ~1 hour), then your passkey installs a fresh one.

While the session key is valid, *you still confirm each action* (the cleartext preview still appears) — but the **signing** is done by the session key, so you don't re-prove your identity with the passkey every time.

**When to use:** an active session — a run of HavenBot conversation, a batch of claims.
**Trade-off:** medium friction, medium assurance. You confirm *what*; you don't re-prove *who*.

## Policy-bound — the automation tier (design)

> Agent can write within the call-allowlist + spend caps you configured. Subject to risk-engine pauses.

Policy-bound is the **intended** "set-and-forget within encrypted bounds" tier. As designed, you set encrypted thresholds and a background engine signs actions that stay inside them:

- **Max drawdown per position** — e.g. 10% of cost basis.
- **Max daily spend** — e.g. $500 per 24-hour window.
- **Min yield to accept** — e.g. a 1% APR floor.
- **Drift tolerance** — e.g. rebalance when allocation drifts >5% from target.

::: details The design — for the curious
- Thresholds live encrypted on-chain (`RiskParams.sol`, `euint64` slots).
- The check uses a **branchless `FHE.select`** so gas cost is identical whether it passes or fails — no decrypt-timing leakage.
- On a breach: async-decrypt on the Fhenix Threshold Network, then an on-chain `settleBreachDecrypt` + `RiskBreach` event on Arbitrum, which pauses the agent and notifies you.
:::

::: warning Not yet wired
The encrypted-threshold engine above is **not running** in any current deployment (see the next section). Today, selecting Policy-bound gives you an allowlist-scoped tier **without** a live risk engine auto-signing or auto-pausing. If you want autonomous execution today, use **Scoped autonomy**.
:::

## Scoped autonomy — the live autonomous tier

> Autonomous buys & sells within a per-op ceiling, time-bounded by TTL. The agent signs without prompting up to the ceiling.

This is the autonomy that actually runs today. You mint a **Scoped session key** from the dashboard in a passkey ceremony, setting two bounds:

- **A per-trade ceiling** — the maximum mhUSDC any single autonomous trade may spend.
- **An expiry (TTL)** — how long the session stays armed before it auto-expires.

A **broker daemon** holds that scoped key and signs the agent's buys, sells, and claims **without prompting you**, up to the ceiling, until the TTL expires or you revoke it. This is what powers the autonomous reinvest runner and the "active Scoped autonomy session" paths in the MCP tools.

The standing rails are the real boundary: a purchase/claim-only call policy (with `transfer` excluded), the per-trade cap, the TTL, and the [`/pause`](/policy/pause) kill-switch — all enforced on-chain by the session-key validator.

**When to use:** hands-off auto-claim and reinvest, or letting the agent trade within a budget while you're away.
**Trade-off:** lowest friction. Your safety comes from the cap + TTL + kill-switch, not from a per-action tap.

## Paused — the kill-switch state

Anyone, on any surface, can call `pause` at any time:

```
> Pause my agent.
```

On-chain effect: `uninstallPlugin(sessionKeyValidator)` — a single transaction that removes the session key from your wallet's permission system (≤ 1 Arb block). Once paused:

- All `propose`/write tools return **`423 PAUSED`**.
- Read tools still work.
- `pause` is idempotent (calling it again is a no-op).
- **Resuming requires your passkey** to install a fresh session key — the old one was uninstalled, so it can't re-authorize itself. On the dashboard this is the **Resume to Advisory** control on the tier picker.

The kill-switch is **global** — pausing on one surface pauses every surface.

See [The /pause kill-switch](/policy/pause).

## Changing tier

You **pick any tier directly** from the dashboard tier picker — there is no step-up/step-down ladder and no required sequence. Whatever tier you choose, your **passkey confirms the change**.

| Tier you pick | What's required |
|---|---|
| Any non-paused tier (Advisory · Confirm per action · Policy-bound) | Choose it directly; your passkey confirms the change |
| **Scoped autonomy** | Choose it directly; a dashboard passkey ceremony sets the per-trade cap + TTL |
| **Paused** | Idempotent — no signature needed (the kill-switch) |
| Resume from **Paused** | Your passkey (session-key reinstall — **Resume to Advisory**) |

Every tier change is recorded as a `tier_transition` row in your [audit log](/policy/audit-log).

## What's bypassed during development

In the spirit of honest docs, here is exactly where the shipped system is simpler than the design above:

1. **No automatic tier ladder.** Tier is **purely user-chosen**. There is no promotion by account age, deposit size, or number of confirmed actions — those signals are tracked but gate nothing. The "graduation ladder" (onboarding → returning → power-user) is a design goal, **not enforced** today.
2. **Policy-bound auto-signing is not running.** The 60-second "policy engine" cron exists in code but is **disabled in every deployment** (`AGENT_POLICY_CRON_ENABLED=false`, set in no environment). Even when enabled it only *sweeps for breaches to pause*; it never auto-signs trades. So Policy-bound does **not** currently execute actions for you — **Scoped autonomy** is the live autonomous path.
3. **Encrypted-threshold gating isn't driven.** `RiskParams.sol` is deployed, but no live engine reads it to gate autonomous trades; the default risk adapter is a no-op stub that always reports "no breach."
4. **Breach auto-pause is contract-present but undriven.** `settleBreachDecrypt` / `RiskBreach` exist on-chain, but nothing runs the cron that would trigger them, so there is no automatic breach → pause today. The manual [`/pause`](/policy/pause) kill-switch is fully live.
5. **KYC runs in dev mode.** `MuHavenIdentityRegistry` ships with `devMode = true`, so `isVerified` returns true for every address — the ERC-3643 whitelist check is bypassed until production KYC partners are wired. (This is compliance, not autonomy, but it's a development bypass worth knowing.)

What *is* fully live and enforced: **Advisory**, **Confirm per action**, **Scoped autonomy** (cap + TTL + on-chain validator), and the **Paused** kill-switch.

## Where next

- [Session keys](/policy/session-keys) — what a session key actually authorizes.
- [The /pause kill-switch](/policy/pause) — the kill-switch in depth.
- [Audit log](/policy/audit-log) — what's recorded across tier transitions.
