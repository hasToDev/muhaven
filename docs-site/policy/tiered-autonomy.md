---
title: Tiered autonomy
description: The four-tier state machine that controls what the agent can do without asking.
---

# Tiered autonomy

Tiered autonomy is the **substrate** every agentic surface shares. It controls **how much the agent can do without asking you each time** — from "ask me every action" to "act within my encrypted bounds and notify on breach."

You set your tier with `muhaven_set_policy(tier, params)` on HavenBot, or `muhaven.policy.set_tier` on MCP / OpenClaw. The tier choice is signed by your passkey. See the [Tool catalog](/reference/tool-catalog) for the cross-surface name mapping.

## The four tiers

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│   Advisory  ──►  Confirm-per-action  ──►  Policy-bound  ──►      │
│       ▲                  ▲                     ▲            │    │
│       └──── /pause ──────┴───── /pause ────────┴── /pause ──┘    │
│                                                            │     │
│                                                            ▼     │
│                                                        Paused    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

| Tier | What happens on every action |
|---|---|
| **Advisory** | LLM proposes; you sign **each** action with your passkey. |
| **Confirm-per-action** | LLM proposes; **session key** signs without re-prompting passkey, within the 1-hour TTL. Each action still opens ConfirmModal. |
| **Policy-bound** | LLM proposes; if within your encrypted thresholds (max drawdown, daily spend, etc.), **cron policy engine** signs without confirmation. Breaches auto-pause and notify. |
| **Paused** | All `propose` tools return 423 PAUSED. Read tools still work. Only `pause` is idempotent (always allowed). |

## Default tier ladder

| Investor stage | Default tier |
|---|---|
| Onboarding (<30 days, <$5K deposits) | Advisory |
| Returning user (≥5 confirmed actions, no breach in 30d) | Confirm-per-action |
| Power user / accredited | Policy-bound (opt-in) |
| After a breach | Paused (auto-flipped) |

The progression mirrors **SEC IM-2017-02** + **FINRA Reg BI Care Obligation** framing — small / new investors get the most friction; experienced / accredited investors get the least.

## Advisory — the default

Every action prompts your passkey. ConfirmModal opens, you confirm with WebAuthn (Touch ID / Windows Hello / hardware key), the UserOp signs.

**When to use:** during onboarding, after a long break, when you're not sure what the agent will do.

**Trade-off:** highest friction, highest assurance. Every action is single-signed by you.

## Confirm-per-action — the daily-driver tier

Your MuHaven wallet installs a **session key** at sign-in. The session key has narrow scope:

- Target: only MuHaven contracts.
- Selector allowlist: only MuHaven SDK functions.
- Value cap per call.
- Total cap per epoch (your daily-spend ceiling, if set).
- `validUntil`: 1 hour from install.

For the next hour, the session key signs without re-prompting your passkey. ConfirmModal still opens per-action (cleartext preview), but the **signing** is automatic via the session key.

After 1 hour, the session key expires. The next action prompts your passkey to install a fresh one.

**When to use:** active trading sessions (1-2 hours of HavenBot conversation), repeated claims, working through a batch of actions.

**Trade-off:** medium friction, medium assurance. You confirm what; you don't re-prove who.

## Policy-bound — the automation tier

Your MuHaven wallet installs the session key as in Confirm-per-action, **and** you set encrypted thresholds on what counts as "within bounds":

- **Max drawdown per position** — e.g., 10% of cost basis.
- **Max daily spend** — e.g., $500 per 24-hour window.
- **Min yield to accept** — e.g., 1% APR floor.
- **Drift tolerance** — e.g., trigger a rebalance when allocation drifts >5% from target.

A backend **cron policy engine** ticks every 60 seconds. For each pending action, it checks the proposed amount against your encrypted thresholds. If the check passes, the session key signs without prompting you. If it fails (a breach), the engine auto-pauses you to Advisory in ~2-3 seconds and notifies you.

::: details Under the hood — for the curious
- Thresholds live encrypted on-chain (`RiskParams.sol`, `euint64` slots).
- The check uses a **branchless `FHE.select`** so the gas cost is identical whether the threshold passes or fails — no decrypt-event timing leakage.
- On breach: async-decrypt (~1.2s on Fhenix Threshold Network) + on-chain `settleBreachDecrypt` (~1.5s on Arbitrum) = end-to-end ~2.5-3s.
- A `RiskBreach` event fires on-chain; the engine then calls `PauseAgentUseCase` to uninstall the session-key validator.
:::

**When to use:** auto-claim cron jobs, rebalancing on drift, set-and-forget yield management.

**Trade-off:** lowest friction, highest pre-configured assurance. You define the bounds; the agent acts within them.

### What a breach does

If any of your thresholds is exceeded (max drawdown / daily spend / min yield / drift tolerance), the cron engine:

1. Async-decrypts the breach event (~2-3 seconds end-to-end).
2. Emits an on-chain `RiskBreach` event.
3. Calls the same pause cascade as `/pause` — uninstalls your session-key validator across every surface.
4. Notifies you (Telegram if linked, dashboard banner on next visit).
5. Writes `breach_detected` + `pause_triggered` rows to your audit log.

Resume requires a manual passkey ceremony — there is no "auto-resume after N minutes" path. The investor must affirmatively re-engage.

::: warning Policy-bound is opt-in
Policy-bound never engages by default, even after the ≥5-confirmed-actions ladder graduation. You have to explicitly request it via `muhaven_set_policy(tier: 'policy_bound', params: {...})` and sign with your passkey.
:::

## Paused — the kill-switch state

Anyone (in any surface) can call `pause` at any time:

```
> Pause my agent.
```

The on-chain effect: `uninstallPlugin(sessionKeyValidator)` — a single tx that removes the session key from your MuHaven wallet's permission system. ≤1 Arb block (~250ms soft).

Once paused:

- All `propose` tools return `423 PAUSED`.
- Read tools still work.
- `pause` itself is idempotent (calling again is a no-op).
- `resume` requires your **passkey** to install a fresh session-key validator (the session key was uninstalled, so you can't use it to re-authorize).

The kill-switch is **global** — pausing on HavenBot pauses MCP, OpenClaw, and the hosted-checkout buyer-side tier-1 flow.

See [The /pause kill-switch](/policy/pause).

## Changing tier

| Direction | Required |
|---|---|
| Advisory ↔ Confirm-per-action | Passkey signature (signs the new session-key validator install) |
| Confirm-per-action → Policy-bound | Passkey signature + encrypted thresholds via `set_policy` payload |
| Policy-bound → Confirm-per-action | Passkey signature (clears encrypted thresholds) |
| Any → Paused | Idempotent — no signature needed |
| Paused → Any | Passkey signature (session-key reinstall ceremony) |

The tier transition itself is recorded as a `tier_transition` audit row.

## Why no fifth tier?

We considered:

- **"Bounded auto-claim only"** — too narrow; Policy-bound already includes claim if you set `auto_claim: true`.
- **"Read-only"** — that's `Paused` plus the read tools, no additional tier needed.
- **"Per-tool tier"** — too complex; ladder simplicity is a feature.

The four-tier ladder is the simplest model that covers the four meaningful confirmation-friction levels.

## Where next

- [Session keys](/policy/session-keys) — what the session key actually authorizes.
- [The /pause kill-switch](/policy/pause) — the kill-switch in depth.
- [Audit log](/policy/audit-log) — what's recorded across tier transitions.
