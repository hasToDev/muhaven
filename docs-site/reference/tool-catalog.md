---
title: Tool catalog (all 4 surfaces)
description: Every tool across HavenBot, MCP, OpenClaw, and Checkout — side by side.
---

# Tool catalog (all 4 surfaces)

A cross-surface comparison of every MuHaven agentic tool. The same backend use-case usually backs multiple surfaces; the column shows whether the surface exposes the tool to the user.

## Two namespace styles, one set of tools

HavenBot uses `muhaven_*` (snake_case — Anthropic / OpenAI function-call convention). MCP / OpenClaw use `muhaven.<group>.<verb>` (dotted — MCP convention). The semantic surface is identical; the names differ because the host runtimes require different identifier shapes.

Column abbreviations below: **HB** = HavenBot · **MCP** = MuHaven MCP server · **OC** = OpenClaw skill + Telegram · **Pay** = Hosted Checkout.

## Read tools

| Capability | HB | MCP | OC | Pay |
|---|---|---|---|---|
| Portfolio summary (ebool flags, token list) | `muhaven_portfolio_summary` | `muhaven.read.portfolio` | ✅ | ❌ |
| Per-token NAV quote | `muhaven_quote` | (rolled into `position.buy` envelope) | (rolled in) | n/a |
| Yield history | (via chat answer) | `muhaven.read.yields` | ✅ | ❌ |
| Per-epoch distribution status | (via chat answer) | `muhaven.read.distribution` | ✅ | ❌ |
| Tokens you hold | (rolled into portfolio_summary) | `muhaven.read.tokens` | ✅ | ❌ |
| Audit log | `muhaven_audit_query` (issuer-self in Wave 4) | `muhaven.read.audit` / `muhaven.issuer.audit_query` | ✅ | ❌ |
| Protection coverage (DefaultProtection P11) | `muhaven_check_protection_coverage` | `muhaven.read.protection_coverage` | ✅ | ❌ |
| KYC attestation registry status (P11) | `muhaven_explain_kyc_attestation` | `muhaven.read.kyc_attestation` | ✅ | ❌ |
| Unseal a specific encrypted handle (client-side) | `muhaven_unseal_position` | (n/a — dashboard-only ceremony) | n/a | n/a |
| Public metrics page | n/a (`api.muhaven.app/api/v1/public/metrics` is unauthenticated) | n/a | n/a | n/a |

## Position tools (state-mutating, propose-only)

| Capability | HB | MCP | OC | Pay |
|---|---|---|---|---|
| Buy (Subscription.purchase) | `muhaven_propose_buy` | `muhaven.position.buy` | ✅ (with tier classifier) | ✅ (sole purpose) |
| Sell / redeem | `muhaven_propose_redeem` | `muhaven.position.sell` | ⛔ excluded | ❌ |
| Claim yield | `muhaven_propose_claim` | `muhaven.position.claim` | ✅ | ❌ |
| Multi-leg rebalance | `muhaven_propose_rebalance` (Wave 5 multicall) | `muhaven.position.rebalance` (Wave 5) | ⛔ excluded | ❌ |

## Policy tools (tier + kill-switch + audit)

| Capability | HB | MCP | OC | Pay |
|---|---|---|---|---|
| Set tier (Advisory ↔ Confirm ↔ Policy-bound) | `muhaven_set_policy` | `muhaven.policy.set_tier` | ⛔ (dashboard-only) | ❌ |
| Pause (kill-switch) | `muhaven_pause` | `muhaven.policy.pause` | ✅ | ❌ |
| Audit export | (via chat answer) | `muhaven.policy.audit_export` | ⛔ (download surface needed) | ❌ |
| Session-key status | (via chat answer) | `muhaven.policy.session_key_status` | ✅ | ❌ |

## Issuer tools (issuer-only)

| Capability | HB | MCP | OC | Pay |
|---|---|---|---|---|
| Distribute yield | `muhaven_propose_distribute_yield` | `muhaven.issuer.distribute_yield` | ⛔ excluded (Telegram is investor-only) | ❌ |
| KYC whitelist add | `muhaven_propose_kyc_add` | `muhaven.issuer.kyc_add` | ⛔ | ❌ |
| KYC whitelist remove | `muhaven_propose_kyc_remove` | `muhaven.issuer.kyc_remove` | ⛔ | ❌ |
| Unpause a new token (set NAV + flip paused) | `muhaven_propose_unpause_token` | `muhaven.issuer.unpause_token` | ⛔ | ❌ |
| Issuer audit query | `muhaven_audit_query` | `muhaven.issuer.audit_query` | ⛔ | ❌ |
| Create checkout link | `create_checkout` | (reserved, not wired in Wave 4) | ❌ | n/a (this is how it gets created) |
| List checkouts | `list_checkouts` (via chat) | (n/a) | ❌ | n/a |
| Cancel checkout | `cancel_checkout` | (reserved) | ❌ | n/a |

## Governance tools (P11, encrypted)

| Capability | HB | MCP | OC | Pay |
|---|---|---|---|---|
| Propose vote | `muhaven_propose_governance_vote` (Wave 5 frontend runner) | `muhaven.governance.propose` (Wave 5 runner) | ⛔ (excluded) | ❌ |
| Cast encrypted vote | `muhaven_cast_encrypted_vote` (Wave 5 frontend runner) | `muhaven.governance.cast_vote` (Wave 5 runner) | ⛔ | ❌ |

## Aggregate counts

| Group | HB (`muhaven_*`) | MCP (`muhaven.*`) | OC subset |
|---|---|---|---|
| Read | 5 + 2 P11 = 7 | 7 | 7 |
| Position | 4 | 4 | 2 (buy + claim) |
| Policy | 3 | 4 | 2 (pause + session_key_status) |
| Issuer | 5 | 5 | 0 |
| Governance | 2 | 2 | 0 |
| **Total** | **17 (Wave 4 close)** | **22 (Wave 4 close)** | **11 (Wave 4 close)** |

::: warning Total counts evolve
Wave 5 adds the in-modal frontend runners for rebalance + governance, but the **tool count** stays the same — the change is the runner, not the catalog.
:::

## Tool-name regex (CI-enforced)

- **HavenBot:** `^muhaven_[a-z][a-z0-9_]*$`
- **MCP:** `^muhaven\.[a-z]+\.[a-z][a-z0-9_]*$`

A failing name pattern fails the lethal-trifecta lint gate at PR time.

::: details Advanced — full namespace specification (developer-facing)
The full namespace + ID rules live in [`development/DEV_WAVE_4/TOOL_NAMESPACE.md`](https://github.com/hasToDev/muhaven/blob/master/development/DEV_WAVE_4/TOOL_NAMESPACE.md). That's an internal implementation document — useful if you're integrating, less useful as user reading.
:::

## What's deliberately excluded (and why)

| Excluded from | Tools | Why |
|---|---|---|
| HavenBot | `*_redeem` (P5 reserved name; the `_propose_redeem` slot is reserved but the runner deferred) | Multi-leg redemption queue ceremony |
| MCP | `*.checkout.*` (slots reserved in TOOL_NAMESPACE) | Buyer-side flow needs a browser passkey ceremony |
| OpenClaw subset | `position.sell`, `position.rebalance` | Multi-leg confirmation doesn't fit the 3-tier Telegram classifier |
| OpenClaw subset | `policy.set_tier`, `policy.audit_export` | Tier transitions need dashboard ceremony; audit export needs a download surface |
| OpenClaw subset | All `issuer.*` (5 tools) | Telegram is investor-only |
| OpenClaw subset | Both `governance.*` | Encrypted vote ceremony needs the cofhe SDK in a browser |
| Hosted Checkout | Everything except buy | Single-purpose surface; the issuer drives create-link via HavenBot |

## Where next

- [Tier matrix](/reference/tier-matrix) — what each tool requires by tier.
- [Status & limits](/reference/status) — what ships now, what's Wave 5.
- [Glossary](/reference/glossary) — terms.
