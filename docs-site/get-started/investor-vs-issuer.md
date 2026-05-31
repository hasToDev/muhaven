---
title: Investor vs issuer
description: One passkey, one role. How to tell them apart and use both.
---

# Investor vs issuer

MuHaven has **two distinct roles**: investor (you hold encrypted RWA balances and pull yield) and issuer (you create tokens, fund yield epochs, and manage the KYC whitelist). The agentic surfaces honor that split — the issuer tools (`muhaven_propose_distribute_yield`, `muhaven_propose_kyc_add`, etc.) only appear when you're signed in as an approved issuer.

## The rule: one passkey, one role

A given passkey-bound MuHaven wallet can be **either** an investor **or** an issuer — never both, by design. Crossing roles after the fact is rejected at the backend (`403 ROLE_MISMATCH` for cross-role login; `403 HAS_INVESTOR_ACTIVITY` if you try to issuer-onboard a wallet that already invested).

If you plan to operate both sides:

1. Register **one passkey** for your investor account.
2. Register **a second passkey** (different name, ideally on a different device or sub-vault in your password manager) for your issuer account.
3. Sign in with the appropriate passkey for whichever role you need that session.

::: warning Why so strict?
Issuers see aggregate KYC whitelist state and can write to it; investors see encrypted personal balances and the yield-claim path. Keeping the MuHaven wallets separate prevents accidental privilege escalation and keeps the audit log unambiguous about which on-chain identity took which action.
:::

## What an investor can do

- Hold encrypted RWA tokens (one or more, picked from the active catalog).
- Buy / redeem via the Subscription surface.
- Claim yield from finalized epochs.
- Set tier / pause / inspect the audit log.
- Vote (encrypted ballot) in governance proposals.
- See public protection-pool state for any RWA token.

## What an issuer can do

- Create RWA tokens (today: wrapped via `MuHavenVault`; native issuance planned for a later release).
- Schedule yield epochs (`SDK.distributeYield → startDistribution → batchCreate → fundFrom`).
- Add / remove investor wallets from the ERC-3643 KYC whitelist.
- Unpause a freshly-deployed token (set NAV + flip `paused=false`).
- Query the issuer-side audit log.
- Mint **hosted-checkout links** to sell to non-customer buyers.
- See aggregate token state (total supply *handle*, holder count) — never per-investor balances.

## How the role check works under the hood

Every backend route that gates on role uses a `withRole('issuer' | 'investor')` middleware:

- Your JWT carries a `role` claim populated at sign-in based on the wallet's registered role.
- If the route says `withRole('issuer')` and your JWT claims `'investor'`, you get **403 NOT_APPROVED_ISSUER**.
- Issuers also pass a separate `issuerStatus === 'approved'` check on every state-mutating tool. Pending or suspended issuers see issuer tools but get **403 NOT_APPROVED_ISSUER** when they try to invoke them.

The same check applies in every surface:

- HavenBot hides issuer tools from investor passkeys.
- `@muhaven/mcp` advertises issuer tools but the backend rejects investor JWTs at the route boundary.
- OpenClaw skill subset *excludes* the issuer namespace entirely (Telegram is investor-only).
- Hosted Checkout's create-link tool is gated on `issuerStatus === 'approved'`.

## End-to-end walkthroughs need two passkeys

If you're recording a demo or doing a manual end-to-end test that exercises both an issuer flow (e.g., distribute yield) and an investor flow (e.g., claim that yield), you need **two passkeys**:

1. Sign in as the issuer, kick off `muhaven_propose_distribute_yield`, sign with the issuer passkey.
2. Sign out.
3. Sign in as an investor with a balance in that token, call `muhaven_propose_claim`, sign with the investor passkey.

Trying to do both with one passkey will fail the role check. Don't.

## Switching between passkeys in your password manager

Most password managers (1Password, Bitwarden, iCloud Keychain) let you give each passkey a recognizable name at creation:

- **MuHaven — Investor (Personal)**
- **MuHaven — Issuer (Treasury)**

At sign-in, the OS dialog will list them by name so you can pick the right one quickly.

## I want to *become* an issuer, but I have investor activity

You can't promote a MuHaven wallet that already invested. The cleanest path: **register a new passkey** and apply-issuer with that one. Your investor MuHaven wallet keeps its balances; the new wallet operates as a separate issuer identity.

The reverse (issuer wants to become an investor) has the same shape — cleanest path is a fresh passkey.

## How to apply as an issuer

Sign in with the passkey you want to use as the issuer, then go to `/apply-issuer`. The flow is:

1. Connect your KYB info (legal entity name, jurisdiction).
2. Pick the token symbol you intend to issue.
3. Wait for approval (today: auto-approved in dev mode; production: manual review until `disableDevModeForever()` is called).

After approval, issuer tools become visible across all four surfaces.
