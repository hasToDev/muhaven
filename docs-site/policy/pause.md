---
title: The /pause kill-switch
description: One tap. ≤1 Arbitrum block. Global across all four surfaces.
---

# The /pause kill-switch

`/pause` is MuHaven's **single-tx kill-switch**. It uninstalls your MuHaven wallet's session-key validator in **≤1 Arbitrum block**. After it fires, every `propose` tool on every surface returns `423 PAUSED` until you explicitly resume.

It's the same surface across HavenBot, MCP, OpenClaw, and the audit copilot — one command, one tx, global effect.

## How to pause

Any of these works:

- **HavenBot:** *"Pause my agent."*
- **MCP:** `muhaven.policy.pause` (no args).
- **Telegram:** `/pause`.
- **Dashboard:** `/agent → Pause button` (top-right red button).

The pause command is **idempotent**: calling it on an already-paused agent is a no-op (returns `200 OK` with `result: 'already_paused'`).

## What pause does mechanically

```
You call pause
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ Backend PauseAgentUseCase                                    │
│   1. Validate the request (auth, scope)                      │
│   2. Mint an unsigned UserOp:                                │
│       to: yourKernelAddress                                  │
│       data: uninstallPlugin(sessionKeyValidatorAddress)      │
│   3. Sign with the master passkey (Advisory tier)            │
│      OR the session key itself (Confirm-per-action — yes,    │
│      the session key can uninstall itself, last action)      │
│   4. Submit via ZeroDev bundler                              │
│   5. Wait for inclusion (~1 block)                            │
│   6. Write audit row: pause_triggered                        │
│   7. Cascade pause to all surface-specific state             │
└──────────────────────────────────────────────────────────────┘
       │
       │ tx settled
       ▼
   Session-key validator no longer in your MuHaven wallet's plugin set
   Every propose UserOp through the session key now fails:
     "0x14eac17b" (PluginUninstalled)
```

## Pause cascade

Pausing cascades across surfaces (T-1 through T-7 in the backend's `PauseAgentUseCase`):

| Step | What happens |
|---|---|
| T-1 | On-chain validator uninstall (the tx above) |
| T-2 | Backend marks user state `paused=true` in `agent_user_state` |
| T-3 | Cron policy engine drops the user from its scheduled tick set |
| T-4 | Open SSE connections (HavenBot chat, checkout buyer-side) receive a `pause` event |
| T-5 | Audit row written |
| T-6 | Webhook subscribers (issuer-side checkout webhooks) receive a `policy.paused` event |
| T-7 | Idempotency guard set so a concurrent pause call is a no-op |

The cascade ensures consistency — a chat session that was mid-conversation when pause fires will see the pause notification in the next stream chunk; a checkout that was waiting for buyer settlement will not block forever (it returns `paused` to the buyer).

## What pause prevents

Once paused, the **session key cannot sign anything**. That means:

- ❌ Buy / sell / claim / rebalance through any surface.
- ❌ Set policy / set tier (these are tier transitions; require passkey resume first).
- ❌ Distribute yield / KYC add / KYC remove / unpause token (issuer side — same session key).
- ❌ Create checkout link (issuer side).
- ❌ Cast governance vote.

What still works:

- ✅ All read tools (portfolio, yields, audit, etc.).
- ✅ Sign in / sign out (the master passkey is unaffected).
- ✅ Read your audit log including the `pause_triggered` row.
- ✅ The buyer-side flow for already-issued checkout sessions (the buyer's MuHaven wallet signs with their own session key; their pause state is independent).

## How to resume

Resume requires your **master passkey** (not the session key — it was uninstalled, so it can't authorize a reinstall):

- **Dashboard:** `/agent → Resume button` → passkey ceremony.
- **HavenBot:** *"Resume my agent."* → opens ConfirmModal → passkey ceremony.
- **MCP / Telegram:** can't drive WebAuthn. Direct user to the dashboard.

The resume flow:

1. You request resume.
2. Backend mints an unsigned UserOp: `installPlugin(sessionKeyValidator, ...)` with fresh scope params.
3. Your master passkey signs (WebAuthn ceremony).
4. Bundler relays; ~1 block to install.
5. Backend writes `pause_lifted` audit row.
6. Cron policy engine re-adds the user.

After resume, you're back in your previous tier (resume doesn't downgrade you). If you want to downgrade as part of resume, use the tier picker in `/agent/policy/transition`.

## Pause + Policy-bound interaction

If you're in Policy-bound tier and the cron engine detects a **breach** (e.g., your $500 daily-spend cap is exceeded), the engine **auto-pauses** to Advisory:

1. Encrypted threshold check via `RiskParams.checkAndExecute` returns `breach=true`.
2. Engine async-decrypts the breach (TN decrypt + on-chain `settleBreachDecrypt`).
3. Engine emits a `RiskBreach` event on-chain.
4. Engine calls `PauseAgentUseCase` for the user (same cascade as a manual pause).
5. User notified via Telegram (if linked) + dashboard banner on next sign-in.

The auto-pause is the **fail-safe** for Policy-bound — bounded autonomy that exits to manual review if bounds are crossed.

## Pause is not "stop everything"

Important nuance: pause stops **your MuHaven wallet's session key from signing**. It does **not**:

- Stop pending bundler submissions that were already in-flight when you paused.
- Stop on-chain events that fire as a result of past UserOps (e.g., a `Settled` event from a buy that was already in the bundler when you paused).
- Roll back any already-settled transactions.

The brief soft-real-time window between pause and validator uninstall means there's a small race where an action submitted just before your pause may still settle. Treat pause as "no new actions" rather than "everything reverts."

## When pause matters most

- **Lost or stolen laptop.** Pause from your phone (`/pause` in Telegram, or sign in from a different device).
- **Suspicious activity in audit log.** Pause first, investigate second.
- **Major market move.** Stop the policy-bound cron from automating something into a fast-moving market.
- **Maintenance window.** Pause before a personal-side migration (e.g., moving to a new password manager).

## Where next

- [Tiered autonomy](/policy/tiered-autonomy) — how pause fits the four-tier ladder.
- [Session keys](/policy/session-keys) — what the validator the pause uninstalls actually authorized.
- [Audit log](/policy/audit-log) — what pause/resume write to the log.
