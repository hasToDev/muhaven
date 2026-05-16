---
title: Tier matrix
description: Which tools are allowed in which tier.
---

# Tier matrix

A quick lookup table for whether a given tool runs in each of the four tiered-autonomy states.

| Tool | Advisory | Confirm-per-action | Policy-bound | Paused |
|---|:---:|:---:|:---:|:---:|
| `read.*` (all 7) | ✅ | ✅ | ✅ | ✅ |
| `position.buy` | ✅ passkey | ✅ session key | ✅ if within bounds | ❌ 423 |
| `position.sell` | ✅ passkey | ✅ session key | ✅ if within bounds | ❌ 423 |
| `position.claim` | ✅ passkey | ✅ session key | ✅ always (claim is fee-bearing pull) | ❌ 423 |
| `position.rebalance` | ✅ passkey (Wave 5 runner) | ✅ session key (Wave 5 runner) | ✅ if within drift bounds (Wave 5) | ❌ 423 |
| `policy.set_tier` | ✅ passkey | ✅ passkey (requires re-auth) | ✅ passkey | ❌ — except `→ resume`, which needs passkey |
| `policy.pause` | ✅ idempotent | ✅ idempotent | ✅ idempotent | ✅ idempotent (no-op) |
| `policy.audit_export` | ✅ | ✅ | ✅ | ✅ |
| `policy.session_key_status` | ✅ | ✅ | ✅ | ✅ |
| `issuer.distribute_yield` | ✅ passkey | ✅ session key | ✅ if within issuer-side bounds | ❌ 423 |
| `issuer.kyc_add` | ✅ passkey | ✅ session key | ✅ if within bounds | ❌ 423 |
| `issuer.kyc_remove` | ✅ passkey | ✅ session key | ✅ if within bounds | ❌ 423 |
| `issuer.unpause_token` | ✅ passkey | ✅ session key | ✅ | ❌ 423 |
| `issuer.audit_query` | ✅ | ✅ | ✅ | ✅ |
| `governance.propose` (Wave 5 runner) | ✅ passkey | ✅ session key | ✅ | ❌ 423 |
| `governance.cast_vote` (Wave 5 runner) | ✅ passkey | ✅ session key | ✅ | ❌ 423 |

**Legend:**

- ✅ **passkey** — Action signed by your master passkey via WebAuthn ceremony.
- ✅ **session key** — Action signed by your scoped session key (no WebAuthn re-prompt for ~1h).
- ✅ **if within bounds** — Cron policy engine signs automatically if the encrypted threshold check passes; on breach, auto-pauses to Advisory.
- ✅ **idempotent** — Always allowed regardless of state.
- ❌ **423** — Returns `423 PAUSED`. Read tools still work.

## Tier transition matrix

| From → To | Allowed | Signer required |
|---|:---:|---|
| Advisory → Confirm-per-action | ✅ | Passkey (signs new session-key validator install) |
| Advisory → Policy-bound | ✅ | Passkey + encrypted threshold setup |
| Advisory → Paused | ✅ | None (always allowed) |
| Confirm-per-action → Advisory | ✅ | Passkey (uninstalls validator) |
| Confirm-per-action → Policy-bound | ✅ | Passkey + encrypted threshold setup |
| Confirm-per-action → Paused | ✅ | None |
| Policy-bound → Advisory | ✅ | Passkey (clears thresholds; uninstalls cron-engine binding) |
| Policy-bound → Confirm-per-action | ✅ | Passkey (clears thresholds) |
| Policy-bound → Paused | ✅ auto on breach | None (manual) or auto (on breach) |
| Paused → Advisory | ✅ | Passkey (reinstalls session-key validator) |
| Paused → Confirm-per-action | ✅ | Passkey |
| Paused → Policy-bound | ✅ | Passkey + threshold setup |

## Breach → auto-pause

A Policy-bound breach (any of: max drawdown, daily spend, min yield, drift tolerance) triggers an auto-pause. The cascade and reasoning live in [Tiered autonomy → Policy-bound](/policy/tiered-autonomy#policy-bound-the-automation-tier).

## Where next

- [Tiered autonomy](/policy/tiered-autonomy) — what each tier means.
- [Tool catalog](/reference/tool-catalog) — what each tool does.
- [The /pause kill-switch](/policy/pause) — the always-on escape hatch.
