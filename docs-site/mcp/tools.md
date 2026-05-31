---
title: '@muhaven/mcp — tool catalog'
description: The 25 tools across read · position · cash · policy · issuer · governance.
---

# MCP tool catalog

`@muhaven/mcp` exposes **25 tools** organized into six groups. Each tool ships with a strict-Zod input schema, an output schema, and a SHA-256 description hash pinned at build time (re-verified on every server startup; drift exits with `EX_CONFIG`).

**Scope** tells you which JWT claim is required (set when you authorized the device).
**Tier-gate** tells you whether the action is blocked when your tiered-autonomy state is `Paused`.

## `muhaven.read.*` — read-only (8 tools)

Always available. No signing required.

| Tool | What it does | Scope | Tier-gate |
|---|---|---|---|
| `muhaven.read.portfolio` | Aggregate portfolio summary (token list, ebool flags). **Never** returns encrypted balance handles or cleartext amounts. | `mcp.read.*` | none |
| `muhaven.read.yields` | Per-token plaintext yield history (epoch index, distribution timestamp, per-share USD). | `mcp.read.*` | none |
| `muhaven.read.distribution` | Distribution status for a (tokenAddress, epochId) tuple — funded / settled / claim-window. | `mcp.read.*` | none |
| `muhaven.read.tokens` | RWA tokens you currently hold (address, symbol, decimals, asset class, status). | `mcp.read.*` | none |
| `muhaven.read.audit` | Your tiered-autonomy audit log (cursor-paginated). User-self only. | `mcp.read.*` | none |
| `muhaven.read.activity` | On-chain activity feed (buys / sells / wraps / unwraps / yield claims / transfers). Each row carries token address, tx hash, block timestamp, and event type — amounts are encrypted handles only. Use to verify a Path C action settled after position.buy / position.sell / cash.wrap. | `mcp.read.*` | none |
| `muhaven.read.protection_coverage` | DefaultProtection coverage state for a token (on-chain proxy state). Returns `not_deployed` when the P11.A contract is not yet on-chain. | `mcp.read.*` | none |
| `muhaven.read.kyc_attestation` | KYC attestation registry status (informational). Returns `not_deployed` when the P11.C registry is not yet on-chain. | `mcp.read.*` | none |

::: tip Read tools are intentionally non-auditing by design
We do **not** log every "user looked at portfolio" call. Only `position.*` / `policy.*` / `issuer.*` / `governance.*` propose+commit events emit audit rows. This is a privacy choice; the trade-off is forensic — see [Audit log](/policy/audit-log).
:::

## `muhaven.position.*` — propose-only trades (4 tools)

All position tools return an **unsigned UserOp envelope plus a broker signature**. They never auto-submit. The host LLM must present the envelope to you for explicit confirmation.

| Tool | What it does | Scope | Tier-gate |
|---|---|---|---|
| `muhaven.position.buy` | Propose a Subscription buy of N shares of token T using mhUSDC. | `mcp.propose.*` | yes |
| `muhaven.position.sell` | Propose a redemption-queue sell. | `mcp.propose.*` | yes |
| `muhaven.position.claim` | Propose a yield claim for one or more (token, epoch) tuples. | `mcp.propose.*` | yes |
| `muhaven.position.rebalance` | Propose a multi-leg atomic rebalance. Returns the descriptor; ceremony completes from a browser surface. | `mcp.propose.*` | yes |

## `muhaven.cash.*` — confidential cash (2 tools)

| Tool | What it does | Scope | Tier-gate |
|---|---|---|---|
| `muhaven.cash.wrap` | Prepare a USDC → mhUSDC wrap. Returns a dashboard deep-link (muhaven.app/cash?amount=...&from=mcp) with the amount pre-filled. Input `amountUsdc` is human-readable ("100" = $100). Verify settlement via muhaven.read.activity (a new "wrap" row). | `mcp.propose.*` | yes |
| `muhaven.cash.unwrap` | Prepare an mhUSDC → USDC withdrawal (inverse of cash.wrap). Returns a dashboard deep-link that lands on the Withdraw form. Two-phase async: burn mhUSDC + request decrypt (~30–60s), then claim USDC from the on-chain reserve. The dashboard drives both phases; this tool never submits either. | `mcp.propose.*` | yes |

## `muhaven.policy.*` — tiered-autonomy state (4 tools)

| Tool | What it does | Scope | Tier-gate |
|---|---|---|---|
| `muhaven.policy.set_tier` | Request or commit a tier transition. Tiers: Advisory / Confirm-per-action / Policy-bound / Paused. | `mcp.propose.*` | special — Paused → any requires the dashboard ceremony |
| `muhaven.policy.pause` | Activate the `/pause` kill-switch. Uninstalls the on-chain validator in ≤1 Arb block. | `mcp.propose.*` | idempotent (always allowed) |
| `muhaven.policy.audit_export` | Drain your audit log to a downloadable JSON. | `mcp.read.*` | none |
| `muhaven.policy.session_key_status` | Inspect the ZeroDev session-key state — install fingerprint, expiration, scope. | `mcp.read.*` | none |

## `muhaven.issuer.*` — issuer-only (5 tools)

Backend routes guard these with `withRole('issuer') && issuerStatus === 'approved'`. An investor-roled JWT or an unapproved issuer-roled JWT gets a 403 `NOT_APPROVED_ISSUER`.

| Tool | What it does | Scope | Tier-gate |
|---|---|---|---|
| `muhaven.issuer.distribute_yield` | Propose `startDistribution → batchCreate → fundFrom` UserOp triple for an epoch. | `mcp.propose.*` | yes |
| `muhaven.issuer.kyc_add` | Propose adding an investor wallet to the ERC-3643 whitelist. | `mcp.propose.*` | yes |
| `muhaven.issuer.kyc_remove` | Propose removing a wallet from the whitelist. | `mcp.propose.*` | yes |
| `muhaven.issuer.unpause_token` | Propose `setNAVAndUnpause` for a freshly-deployed token. | `mcp.propose.*` | yes |
| `muhaven.issuer.audit_query` | Read your own issuer-side tiered-autonomy audit log. | `mcp.read.*` | none |

## `muhaven.governance.*` — encrypted governance (2 tools)

| Tool | What it does | Scope | Tier-gate |
|---|---|---|---|
| `muhaven.governance.propose` | Propose an EncryptedGovernance vote. Supports `proposalType=0` (TRIGGER_PROTECTION). | `mcp.propose.*` | yes |
| `muhaven.governance.cast_vote` | Cast an encrypted vote on an open proposal. Backend enforces voter eligibility. | `mcp.propose.*` | yes |

## Read-only mode

Set `MUHAVEN_READ_ONLY=true` in the broker env to register **only the eight `muhaven.read.*` tools**. The position / cash / policy / issuer / governance groups are not even surfaced to the host LLM — defense in depth for a "give my LLM read-only visibility" deployment.

See [Read-only mode](/mcp/read-only-mode).

## Tool description hashes

Every tool description is hashed with SHA-256 at build time into `packages/mcp/tool-hashes.json`. The MCP server re-verifies on startup; any drift exits with code 70 (`EX_CONFIG`). This is the [`mcp-context-protector` pattern](https://github.com/anthropics/mcp-context-protector) — guards against post-install MCPoison-style description swaps.

If an `npm update` ever changes a tool's description, your install will refuse to start until you re-verify and update the pin. That's intentional: the description is part of the security contract.

## Why no `muhaven.checkout.*` MCP tools?

The hosted-checkout surface creates URLs that buyers redeem in a browser. It's not LLM-callable end-to-end: an LLM can mint a checkout link (via HavenBot's `create_checkout` tool), but the buyer-side flow needs a real browser for the passkey ceremony.

## Where next

- [First chat](/mcp/first-chat) — walk through your first portfolio query.
- [Playbook](/mcp/playbook) — scenarios that span MuHaven plus other MCP servers.
- [Read-only mode](/mcp/read-only-mode) — restrict your install.
- [Tool catalog (all surfaces)](/reference/tool-catalog) — cross-surface comparison.
