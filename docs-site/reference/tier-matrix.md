---
title: Tier matrix
description: Which tools are allowed in which tier.
---

# Tier matrix

A quick lookup table for whether a given tool runs in each of the five tiered-autonomy states. **Scoped autonomy** is the live autonomous tier (a bounded session key + broker daemon sign within a per-trade cap and TTL, no per-action prompt). **Policy-bound** is a designed automation tier whose encrypted-threshold auto-signing engine is built but disabled in every deployment — selecting it yields an allowlist-scoped tier without a live risk engine (the "if within bounds" auto-signing below describes the design, not current behavior).

| Tool | Advisory | Confirm-per-action | Policy-bound (engine disabled) | Scoped autonomy (live) | Paused |
|---|:---:|:---:|:---:|:---:|:---:|
| `read.*` (all 7) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `position.buy` | ✅ passkey | ✅ session key | ✅ allowlist-scoped (design: if within bounds) | ✅ within cap + TTL | ❌ 423 |
| `position.sell` | ✅ passkey | ✅ session key | ✅ allowlist-scoped (design: if within bounds) | ✅ within cap + TTL | ❌ 423 |
| `position.claim` | ✅ passkey | ✅ session key | ✅ (claim is fee-bearing pull) | ✅ within cap + TTL | ❌ 423 |
| `position.rebalance` | ✅ passkey | ✅ session key | ✅ allowlist-scoped (design: if within drift bounds) | ✅ within cap + TTL | ❌ 423 |
| `policy.set_tier` | ✅ passkey | ✅ passkey (requires re-auth) | ✅ passkey | ✅ passkey | ❌ — except `→ resume`, which needs passkey |
| `policy.pause` | ✅ idempotent | ✅ idempotent | ✅ idempotent | ✅ idempotent | ✅ idempotent (no-op) |
| `policy.audit_export` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `policy.session_key_status` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `issuer.distribute_yield` | ✅ passkey | ✅ session key | ✅ allowlist-scoped (design: if within issuer-side bounds) | ✅ within cap + TTL | ❌ 423 |
| `issuer.kyc_add` | ✅ passkey | ✅ session key | ✅ allowlist-scoped (design: if within bounds) | ✅ within cap + TTL | ❌ 423 |
| `issuer.kyc_remove` | ✅ passkey | ✅ session key | ✅ allowlist-scoped (design: if within bounds) | ✅ within cap + TTL | ❌ 423 |
| `issuer.unpause_token` | ✅ passkey | ✅ session key | ✅ | ✅ within cap + TTL | ❌ 423 |
| `issuer.audit_query` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `governance.propose` | ✅ passkey | ✅ session key | ✅ | ✅ | ❌ 423 |
| `governance.cast_vote` | ✅ passkey | ✅ session key | ✅ | ✅ | ❌ 423 |

**Legend:**

- ✅ **passkey** — Action signed by your master passkey via WebAuthn ceremony.
- ✅ **session key** — Action signed by your scoped session key (no WebAuthn re-prompt for ~1h).
- ✅ **within cap + TTL** — Scoped autonomy: the broker daemon signs without prompting as long as the trade is within your per-trade cap and the session key's TTL hasn't expired.
- ✅ **allowlist-scoped (design: if within bounds)** — Policy-bound: the action is allowed within the tier's allowlist scope. The encrypted-threshold auto-signing engine ("if within bounds") is built but disabled in every deployment, so the bounds check is not driven today.
- ✅ **idempotent** — Always allowed regardless of state.
- ❌ **423** — Returns `423 PAUSED`. Read tools still work.

## Tier transition matrix

| From → To | Allowed | Signer required |
|---|:---:|---|
| Advisory → Confirm-per-action | ✅ | Passkey (signs new session-key validator install) |
| Advisory → Policy-bound | ✅ | Passkey + allowlist scope (encrypted threshold setup is part of the disabled design) |
| Advisory → Scoped autonomy | ✅ | Passkey (signs bounded session-key install: per-trade cap + TTL) |
| Advisory → Paused | ✅ | None (always allowed) |
| Confirm-per-action → Advisory | ✅ | Passkey (uninstalls validator) |
| Confirm-per-action → Policy-bound | ✅ | Passkey + allowlist scope |
| Confirm-per-action → Scoped autonomy | ✅ | Passkey (signs bounded session-key install) |
| Confirm-per-action → Paused | ✅ | None |
| Policy-bound → Advisory | ✅ | Passkey (clears scope) |
| Policy-bound → Confirm-per-action | ✅ | Passkey |
| Policy-bound → Scoped autonomy | ✅ | Passkey (signs bounded session-key install) |
| Policy-bound → Paused | ✅ | None (manual) |
| Scoped autonomy → Advisory | ✅ | Passkey (revokes bounded session key) |
| Scoped autonomy → Confirm-per-action | ✅ | Passkey |
| Scoped autonomy → Paused | ✅ | None (always allowed; `/pause` revokes the session key) |
| Paused → Advisory | ✅ | Passkey (reinstalls session-key validator) |
| Paused → Confirm-per-action | ✅ | Passkey |
| Paused → Policy-bound | ✅ | Passkey + allowlist scope |
| Paused → Scoped autonomy | ✅ | Passkey (signs bounded session-key install) |

## Breach → auto-pause (designed, not driven)

In the Policy-bound design, a breach (any of: max drawdown, daily spend, min yield, drift tolerance) would trigger an auto-pause. The breach-and-auto-pause path is present in the contracts but is **not driven in any deployment** today, because the encrypted-threshold engine that detects breaches is disabled. The cascade and reasoning live in [Tiered autonomy → Policy-bound](/policy/tiered-autonomy). The live autonomous tier — Scoped autonomy — bounds risk instead via a per-trade cap and session-key TTL rather than a running breach engine.

## Where next

- [Tiered autonomy](/policy/tiered-autonomy) — what each tier means.
- [Tool catalog](/reference/tool-catalog) — what each tool does.
- [The /pause kill-switch](/policy/pause) — the always-on escape hatch.
