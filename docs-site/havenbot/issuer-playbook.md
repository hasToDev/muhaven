---
title: HavenBot — issuer playbook
description: Phrasing for distribute yield, manage KYC, unpause, create checkout links.
---

# Issuer playbook

The issuer-facing surface of HavenBot lands in the same `/agent` route as the investor one, but five additional tools become visible to **issuer-roled and `issuerStatus === 'approved'`** MuHaven wallets: distribute yield, KYC add/remove, unpause a freshly-deployed token, and an audit copilot.

Every row below follows the same shape: **what you say** → **what the agent calls** → **what you confirm**.

> `<TOKEN>` and `RWA1` are placeholders for whichever token you're working with — replace them with the actual symbol on your dashboard.

If you don't see the issuer tools, check:

1. You're signed in with your **issuer passkey** (not your investor passkey — they're separate per the [one passkey, one role](/get-started/investor-vs-issuer) rule).
2. Your issuer status is `approved` (visit `/apply-issuer` to check).

## Distribute yield

The single most common issuer flow. Schedules a yield epoch for a token's holders.

| You want | Say |
|---|---|
| Schedule a yield epoch | "Distribute $50,000 of yield to `<TOKEN>` holders for May." |
| Quick schedule | "Distribute $25K to `<TOKEN>`." *(label defaults to current quarter)* |
| Test the wiring | "Distribute $1 to `<TOKEN>` holders." *(useful on testnet)* |
| Per-share rate target | "Distribute yield to `<TOKEN>` at $0.0012 per share." |
| Recap last epoch | "How much did I distribute on `<TOKEN>` last epoch?" |

Under the hood HavenBot calls `muhaven_propose_distribute_yield` which triggers the SDK pipeline:

1. `startDistribution` — opens the epoch on `YieldDistributor`.
2. `batchCreate` — creates a per-investor `MuHavenEscrow` (default batch size 50, max 200).
3. `fundEscrows` — funds each escrow with the proportional cleartext amount.

The ConfirmModal shows a multi-leg breakdown. **You sign once** with your issuer passkey; the SDK fans out the batched UserOps.

::: tip Yield distribution is per-investor at the contract level
The contract creates a separate `MuHavenEscrow` per holder, not a single shared pool. This is what makes the per-investor claim privacy-preserving: when an investor later claims, they pull only their escrow — and the operator never knows the amount.
:::

## KYC churn

| You want | Say |
|---|---|
| Add an investor to whitelist | "Add 0xabc…123 to `<TOKEN>`'s whitelist." |
| Add an accredited investor | "Add 0xabc…123 to `<TOKEN>`'s whitelist as tier 2 accredited." |
| Remove an investor | "Remove 0xdef…456 from `<TOKEN>`." |
| Verify membership | "Is 0xabc…123 on `<TOKEN>`'s whitelist?" |
| Bulk adds | "Add the following addresses to `<TOKEN>`: 0xabc…, 0xdef…, 0x123…" *(HavenBot prompts you per address)* |

Tier 1 = retail KYC (one `addToWhitelist` UserOp). Tier 2 = accredited (two sequential UserOps: `addToWhitelist` + `addToAccreditedList`).

Removal **auto-clears** the tier-2 accredited flag — see `ERC3643KYCAdapter.sol:103-110`.

::: warning KYC bypass in dev mode
During development, MuHavenIdentityRegistry runs in dev mode (`devMode=true` → `isVerified` always returns true, no whitelist enforcement). KYC tools work but the on-chain compliance check is bypassed until production KYC partners are wired.
:::

## Unpause a freshly-deployed token

When you complete the F2 token-creation wizard, the new token is **paused** by default. To activate it, you need to set its initial NAV and flip `paused = false`. HavenBot does both in one signed action:

| You want | Say |
|---|---|
| Activate a new token | "`<TOKEN>`'s first NAV came in at $0.998 — set NAV and unpause." |
| Re-quote and activate | "What's the suggested initial NAV for `<TOKEN>`? Then activate." *(HavenBot reads the off-chain price feed and proposes the value)* |
| Inspect status | "Is `<TOKEN>` active or still paused?" |

This calls `muhaven_propose_unpause_token`, which signs **two UserOps** with your issuer passkey:

1. `IssuerControlledOracle.setNAV(token, initialNav)` — writes the first NAV.
2. `TokenRegistry.setPaused(token, false)` — flips the paused flag.

Both signed by your **issuer passkey** (production-trajectory shape — NOT the deployer-side `scripts/unpause-token.ts` automation that exists for dev convenience).

The tool is **idempotent**: if the token is already unpaused, HavenBot refuses with `409 ALREADY_ACTIVE` instead of re-issuing the UserOps.

## Audit copilot

| You want | Say |
|---|---|
| Recent issuer audit | "Show my issuer audit log." |
| Filter by surface | "Show audit rows that came from MCP." |
| Filter by tool | "Show every distribute_yield I've run this month." |
| Filter by token | "Show audit for `<TOKEN>` this quarter." |
| Export | "Export my issuer audit log for the last 90 days." |

Issuer audit is **self-only with a 90-day window cap**.

## Create a hosted-checkout link

::: warning In development
Hosted checkout is an in-development surface — it isn't live yet. The phrasing below describes the planned issuer-side flow.
:::

The hosted-checkout surface at `muhaven.app/pay/...` is designed to be operated entirely from the issuer side via HavenBot:

| You want | Say |
|---|---|
| Create a one-off pay link | "Create a checkout link for 500 mhUSDC of `<TOKEN>` expiring in 24 hours." |
| With a custom label | "Create a checkout link for 1000 mhUSDC of `<TOKEN>` for buyer 'Acme Treasury'." |
| With a webhook | "Create a checkout link for 200 mhUSDC of `<TOKEN>` with webhook https://my.api/cb." |
| Inspect status | "What's the status of checkout `chk_01HMTV…`?" |
| List recent | "Show my recent checkouts." or "Show my pending checkouts." |
| Cancel an unredeemed link | "Cancel checkout `chk_01HMTV…`." |

The link HavenBot returns has the **fragment-key** structure — the key is in the URL fragment so it never reaches our server. See [URL fragment key (privacy)](/checkout/fragment-key).

The buyer follows the link, pays with their own passkey, and the SSE channel pushes you a real-time "Paid" notification.

## What about token creation?

Token creation (the F2 wizard) is **not** in HavenBot. It's a multi-step dashboard wizard at `/issuer/tokens/new` because it needs uploads, jurisdictional metadata, and a registry-deploy step that doesn't fit a single tool call.

HavenBot picks up where the F2 wizard ends: at step 6 (set initial NAV + unpause), `muhaven_propose_unpause_token` is the natural handoff.

## What HavenBot won't do for issuers

- **It won't move yield from your treasury to a non-investor wallet.** Yield distribution targets MuHavenEscrow contracts only; the issuer's MuHaven wallet can't divert.
- **It won't decrypt investor balances.** The issuer sees aggregates (total supply *handle*, holder count) — never per-investor amounts.
- **It won't auto-approve KYC.** Every add/remove is a deliberate signed action.
- **It won't act as another issuer.** Cross-issuer audit access requires a permit signed by the other issuer.

## Common mistakes

- **"Distribute yield to my token"** without specifying which token → HavenBot asks which one.
- **"Add this whitelist"** with a list pasted as plaintext → HavenBot parses one address at a time and prompts you per row.
- **"Unpause `<TOKEN>`"** without specifying initial NAV → HavenBot will quote from the oracle but ask you to confirm; setting NAV is a signed action you don't want auto-defaulted.

## Where next

- [Investor playbook](/havenbot/investor-playbook) — the investor-side phrasing.
- [Hosted Checkout for issuers](/checkout/for-issuers) — the create-link flow end-to-end.
- [Audit log](/policy/audit-log) — what's logged and how to query it.
