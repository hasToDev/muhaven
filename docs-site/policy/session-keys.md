---
title: Session keys
description: The short-lived signers that handle your day-to-day actions.
---

# Session keys

A **session key** is a short-lived ECDSA key with **narrow scope** installed in your ZeroDev kernel by your passkey. For its lifetime (default 1 hour), it can sign MuHaven UserOps without prompting you for a passkey on every action.

Session keys are how Confirm-per-action tier feels frictionless without sacrificing scope safety. They're also how the cron policy engine signs in Policy-bound tier.

## What the session key can do

Locked at install time by the `@zerodev/permissions` `CallPolicy` / `GasPolicy` / `RateLimitPolicy` validators:

- **Target contracts:** an allowlist of MuHaven contract addresses (Subscription, RedemptionQueue, YieldSnapshot, RiskParams, etc.).
- **Function selectors:** an allowlist of specific 4-byte selectors. A transfer to an arbitrary EOA is not in the list.
- **Value cap per call:** session key cannot send more than $N in one UserOp.
- **Value cap per epoch:** session key cannot send more than $N total in the validity window (your daily-spend ceiling, if set).
- **`validUntil`:** a Unix timestamp after which the validator refuses to authorize anything. Default 1 hour from install.

You can inspect the current session-key state via `muhaven.policy.session_key_status` (MCP) or by asking HavenBot: *"Show my session-key permissions."*

## Why a session key instead of "just use the passkey"

Three reasons:

1. **UX.** Touch ID / Windows Hello on every click is exhausting. The session key signs in ~50ms; the passkey ceremony is ~1-2 seconds + a biometric prompt.
2. **Scope reduction.** Your passkey signs *anything* the kernel asks. The session key signs only what the validators allow. A leaked session key isn't a drain-the-account key.
3. **Cron-friendly.** A passkey requires a user-present WebAuthn ceremony. A session key can be invoked by a backend cron (Policy-bound tier) without user interaction.

## Lifecycle

```
You sign in / change tier
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ ZeroDev kernel install_session_key(                          │
│   target_allowlist: [...MuHaven contracts...],               │
│   selector_allowlist: [...MuHaven SDK fns...],               │
│   value_cap: 5_000_000_000,    // $5K per call               │
│   epoch_cap: 50_000_000_000,   // $50K per epoch             │
│   validUntil: now + 1h,                                      │
│ )                                                             │
└──────────────────────────────────────────────────────────────┘
       │
       │ install signed by passkey
       ▼
┌──────────────────────────────────────────────────────────────┐
│ Session key (private half held by broker / browser)          │
│ signs UserOps within scope for 1 hour                        │
└──────────────────────────────────────────────────────────────┘
       │
       │ on /pause: validator uninstalled
       │ on validUntil: validator refuses to authorize
       ▼
   Refuses; next action prompts passkey for fresh install
```

## Where the session-key private half lives

Depends on the surface:

| Surface | Private half held by |
|---|---|
| **HavenBot dashboard** | Browser-local (`window.localStorage` + Web Crypto subtle key, encrypted with a kernel-derived key) |
| **`@muhaven/mcp`** | `muhaven-broker` daemon — in OS keychain or 0600-mode file |
| **OpenClaw + Telegram inline** | Backend service-secret bound to the inline tier; signed server-side via the kernel's session-key validator |
| **OpenClaw + Telegram Mini-App OTP** | Same as inline — backend-side, gated by Mini App OTP |
| **OpenClaw + Telegram passkey deeplink** | Browser-local (deeplink to dashboard `/agent/confirm`) |
| **Hosted Checkout** | Browser-local during checkout; transient session, no persistence |
| **Policy-bound cron** | Backend cron service, stored in TPM-backed or KMS-bound keystore on the policy-engine host |

The session key **never** lives in an LLM process, an env var, or a long-lived browser cookie. The broker pattern + OS keychain ensures the LLM-jailbreak path cannot exfiltrate the key.

## Why the broker daemon for MCP

`@muhaven/mcp` is the most security-sensitive surface because it runs alongside an LLM you brought yourself. If the session key lived in the MCP server process (e.g., loaded from env block), a jailbroken LLM could read it. The broker daemon:

- Runs in a **separate process** under your user.
- Holds the key in OS keychain (or 0600-mode file).
- Exposes only `sign_hash` over Unix socket / named pipe (no network surface).
- POSIX peer-credentials check ACLs the broker to only the owning user's processes.

See [Broker daemon](/mcp/broker) for the full architecture.

## Rate-limit policy validator

The session key carries a `RateLimitPolicy` validator that throttles call rate even within the value-cap window. Default rate limits:

- 60 calls per minute (read tools — even read tools sometimes write to encrypted accumulators).
- 10 propose calls per minute.
- 3 commits per minute (settled UserOps).

A jailbroken LLM that tried to drain your kernel via thousands of small buys would hit the rate-limit before the value-cap kicks in.

## When session keys are uninstalled

Three triggers:

1. **`/pause`** — `uninstallPlugin(sessionKeyValidator)` removes the validator immediately. ≤1 Arb block.
2. **`validUntil` expiry** — the validator silently stops accepting signatures past the timestamp. No on-chain action; the kernel's `validateUserOp` returns invalid.
3. **Manual uninstall** — `muhaven.policy.session_key_status` shows the current install; ask HavenBot *"Uninstall my session key"* to force a reinstall on next action.

## Why not longer TTLs?

We considered 24h / 7d / "until you sign out". The 1h default balances:

- **UX friction** — a working session is rarely longer than 1h without a natural break for re-auth.
- **Phishing window** — if your laptop is briefly unattended, 1h is the maximum exposure window.
- **Reg BI proxy** — short TTLs satisfy "investor must be present for high-stakes decisions" framing.

You can configure a different TTL via `VITE_SESSION_KEY_DURATION_SEC` (frontend) / `MUHAVEN_SESSION_KEY_TTL_SEC` (MCP broker). Wave 5 may add a per-action TTL override.

## What you can't do with a session key

- **Send funds to a non-MuHaven address.** Not in the target allowlist.
- **Upgrade your kernel's validator config.** Reserved for passkey signature.
- **Sign cross-chain UserOps.** Session key is chain-bound; cross-chain ops require passkey re-authorization.
- **Drain your kernel.** Value-cap + rate-limit + selector-allowlist make this structurally impossible.

## Where next

- [Tiered autonomy](/policy/tiered-autonomy) — how session keys map to tiers.
- [The /pause kill-switch](/policy/pause) — kill-switch in depth.
- [Threat model in plain language](/policy/threats) — what session keys protect against.
