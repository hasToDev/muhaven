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
| Audit log | `muhaven_audit_query` (issuer-self) | `muhaven.read.audit` / `muhaven.issuer.audit_query` | ✅ | ❌ |
| Protection coverage (DefaultProtection) | `muhaven_check_protection_coverage` | `muhaven.read.protection_coverage` | ✅ | ❌ |
| KYC attestation registry status | `muhaven_explain_kyc_attestation` | `muhaven.read.kyc_attestation` | ✅ | ❌ |
| Unseal a specific encrypted handle (client-side) | `muhaven_unseal_position` | (n/a — dashboard-only ceremony) | n/a | n/a |

## Position tools (state-mutating, propose-only)

| Capability | HB | MCP | OC | Pay |
|---|---|---|---|---|
| Buy (Subscription.purchase) | `muhaven_propose_buy` | `muhaven.position.buy` | ✅ (with tier classifier) | ✅ (sole purpose) |
| Sell / redeem | `muhaven_propose_redeem` | `muhaven.position.sell` | ⛔ excluded | ❌ |
| Claim yield | `muhaven_propose_claim` | `muhaven.position.claim` | ✅ | ❌ |
| Multi-leg rebalance | `muhaven_propose_rebalance` | `muhaven.position.rebalance` | ⛔ excluded | ❌ |

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
| Create checkout link | `create_checkout` | (dashboard-only) | ❌ | n/a (this is how it gets created) |
| List checkouts | `list_checkouts` (via chat) | (n/a) | ❌ | n/a |
| Cancel checkout | `cancel_checkout` | (dashboard-only) | ❌ | n/a |

## Governance tools (encrypted)

| Capability | HB | MCP | OC | Pay |
|---|---|---|---|---|
| Propose vote | `muhaven_propose_governance_vote` | `muhaven.governance.propose` | ⛔ (excluded) | ❌ |
| Cast encrypted vote | `muhaven_cast_encrypted_vote` | `muhaven.governance.cast_vote` | ⛔ | ❌ |

## Aggregate counts

| Group | HB (`muhaven_*`) | MCP (`muhaven.*`) | OC subset |
|---|---|---|---|
| Read | 7 | 7 | 7 |
| Position | 4 | 4 | 2 (buy + claim) |
| Policy | 3 | 4 | 2 (pause + session_key_status) |
| Issuer | 5 | 5 | 0 |
| Governance | 2 | 2 | 0 |
| **Total** | **17** | **22** | **11** |

## Tool-name regex (CI-enforced)

- **HavenBot:** `^muhaven_[a-z][a-z0-9_]*$`
- **MCP:** `^muhaven\.[a-z]+\.[a-z][a-z0-9_]*$`

A failing name pattern fails the lethal-trifecta lint gate at PR time.

## What's deliberately excluded (and why)

| Excluded from | Tools | Why |
|---|---|---|
| MCP | `*.checkout.*` | Buyer-side flow needs a browser passkey ceremony |
| OpenClaw subset | `position.sell`, `position.rebalance` | Multi-leg confirmation doesn't fit the 3-tier Telegram classifier |
| OpenClaw subset | `policy.set_tier`, `policy.audit_export` | Tier transitions need dashboard ceremony; audit export needs a download surface |
| OpenClaw subset | All `issuer.*` (5 tools) | Telegram is investor-only |
| OpenClaw subset | Both `governance.*` | Encrypted vote ceremony needs the cofhe SDK in a browser |
| Hosted Checkout | Everything except buy | Single-purpose surface; the issuer drives create-link via HavenBot |

## Where next

- [Tier matrix](/reference/tier-matrix) — what each tool requires by tier.
- [Glossary](/reference/glossary) — terms.
