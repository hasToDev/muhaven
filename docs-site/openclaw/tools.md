---
title: OpenClaw — available tools
description: The 11-tool investor subset bundled with the skill.
---

# Available tools

The OpenClaw skill bundles a **deliberate subset** of `@muhaven/mcp` — 11 tools out of 22. The subset is locked at the type level: a `verify-subset.ts` build gate enforces a three-way consistency check between the skill's `TOOLSET_SUBSET` constant, `manifest.json#mcp.tool_subset`, and `SKILL.md` frontmatter.

## What's included (11 tools)

### Read (7 tools)

All read tools from `@muhaven/mcp` are included:

| Tool | What it does |
|---|---|
| `muhaven.read.portfolio` | Aggregate portfolio summary. |
| `muhaven.read.yields` | Per-token yield history. |
| `muhaven.read.distribution` | Per-epoch distribution status. |
| `muhaven.read.tokens` | RWA tokens you hold. |
| `muhaven.read.audit` | Your tiered-autonomy audit log. |
| `muhaven.read.protection_coverage` | DefaultProtection coverage for a token (P11). |
| `muhaven.read.kyc_attestation` | KYC attestation registry status (P11). |

### Position (2 tools — buy + claim only)

| Tool | What it does |
|---|---|
| `muhaven.position.buy` | Propose a Subscription buy. Tier-gated via OpenClaw three-tier classifier. |
| `muhaven.position.claim` | Propose a yield claim for one or more (token, epoch) tuples. |

### Policy (2 tools — pause + status only)

| Tool | What it does |
|---|---|
| `muhaven.policy.pause` | Activate the `/pause` kill-switch. Always allowed regardless of tier. |
| `muhaven.policy.session_key_status` | Inspect the ZeroDev session-key state. |

## What's deliberately excluded (11 tools)

| Excluded tool | Why excluded |
|---|---|
| `position.sell` | Multi-leg redemption queue ceremony doesn't fit a three-tier Telegram confirmation. |
| `position.rebalance` | Multi-leg multicall doesn't fit a single inline-button confirmation. |
| `policy.set_tier` | Tier transitions need the dashboard WebAuthn ceremony (Paused → any). |
| `policy.audit_export` | Audit export needs a download surface, not a Telegram message. |
| `issuer.distribute_yield` | OpenClaw skill is investor-only (per ADR-C). |
| `issuer.kyc_add` | Same. |
| `issuer.kyc_remove` | Same. |
| `issuer.unpause_token` | Same. |
| `issuer.audit_query` | Same. |
| `governance.propose` | Encrypted-vote ceremony needs the cofhe SDK in a browser. |
| `governance.cast_vote` | Same. |

If you need these tools, use [HavenBot](/havenbot/overview) or [`@muhaven/mcp`](/mcp/overview) on a non-OpenClaw host.

## Bot command mapping

When you interact with the Telegram bot, commands route to MCP tools as follows:

| Bot command | MCP tool |
|---|---|
| `/portfolio` | `muhaven.read.portfolio` |
| `/yields <token>` | `muhaven.read.yields` |
| `/distribution <token> <epoch>` | `muhaven.read.distribution` |
| `/tokens` | `muhaven.read.tokens` |
| `/audit` | `muhaven.read.audit` |
| `/protection <token>` | `muhaven.read.protection_coverage` |
| `/kyc <token> <address>` | `muhaven.read.kyc_attestation` |
| `/buy <amount> <token>` | `muhaven.position.buy` (with tier classifier) |
| `/claim <token> <epoch>` | `muhaven.position.claim` (with tier classifier) |
| `/pause` | `muhaven.policy.pause` |
| `/sessionkey` | `muhaven.policy.session_key_status` |

## Why a subset?

Three reasons:

1. **Phone-first UX assumptions don't match every tool.** Multi-leg ceremonies (sell, rebalance, distribute_yield) and ceremony-gated tools (set_tier, governance) need a browser surface.
2. **Investor-only on Telegram.** Issuer flows have stricter trust assumptions (issuer kernel signing) and benefit from the dashboard's full audit copilot rendering. They're available on HavenBot and MCP instead.
3. **Smaller attack surface.** The OpenClaw skill runs as a sandboxed binary with declared egress allowlist. The fewer tools in the catalog, the smaller the prompt-injection attack surface.

## How the subset is enforced

The skill's `src/index.ts` calls `runMcpStdioCli({ filterRegistry })` from `@muhaven/mcp/server.ts`. The filter is a synchronous callback that:

1. Receives the full 22-tool registry from the bundled MCP server.
2. Returns only the 11 tools in the `TOOLSET_SUBSET` set.
3. Refuses to start if the filtered registry is empty (sanity check against a typo'd subset).

The hash verification gate fires **before** the filter — so an attacker who patched a single descriptor cannot hide it by shipping a subset filter that excludes the patched tool. The descriptor is verified, *then* filtered. This is documented in `packages/openclaw-skill/src/index.ts` NatSpec.

## Where next

- [Telegram bot](/openclaw/telegram-bot) — the commands above in context.
- [Three confirmation tiers](/openclaw/confirmation-tiers) — how the tier classifier wraps each propose call.
- [Troubleshooting](/openclaw/troubleshooting) — common skill + bot issues.
