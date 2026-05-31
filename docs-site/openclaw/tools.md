---
title: OpenClaw — available tools
description: The 11-tool investor subset bundled with the skill, with command examples.
---

::: warning 🚧 In development — not in the Testing Guide
This surface is still being hardened and isn't part of the [Testing Guide](/guide/). The page below describes the intended design. To evaluate MuHaven today, use [HavenBot](/havenbot/overview) or the [MCP server](/mcp/overview).
:::

# Available tools

The OpenClaw skill bundles a **deliberate subset** of `@muhaven/mcp` — 11 tools out of 25. The subset is locked at the type level: a `verify-subset.ts` build gate enforces a three-way consistency check between the skill's `TOOLSET_SUBSET` constant, `manifest.json#mcp.tool_subset`, and `SKILL.md` frontmatter.

Every section below shows the bot command you type **and** a representative bot reply, so you can see what to expect before you try it.

> Throughout this page, `<TOKEN>` and `RWA1` stand in for whichever active RWA token you hold. Your `/tokens` command lists what's currently in your catalog.

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
| `muhaven.read.protection_coverage` | DefaultProtection coverage for a token. |
| `muhaven.read.kyc_attestation` | KYC attestation registry status. |

**Example — portfolio + a token-specific yield check:**

```
You → /portfolio

@muhaven_bot → 🪙 You hold 3 RWA tokens.
                  Status: balanced · last sync 09:14 UTC
                  (encrypted handles hidden — open the dashboard
                   to decrypt locally with your permit)

You → /yields <TOKEN>

@muhaven_bot → <TOKEN> yield, last 5 epochs:
                  • Epoch 7 — $0.00129 / share (May 15)
                  • Epoch 6 — $0.00134 / share (Apr 15)
                  • Epoch 5 — $0.00118 / share (Mar 15)
                  • Epoch 4 — $0.00120 / share (Feb 15)
                  • Epoch 3 — $0.00115 / share (Jan 15)
                  Annualized ≈ 1.5%
```

Other useful read commands (same shape, different tool):

```
You → /tokens
@muhaven_bot → 3 active RWA tokens: <TOKEN>, RWA1, RWA2

You → /audit
@muhaven_bot → Last 10 audit rows:
                  • 11:42 propose_buy <TOKEN> 50 mhUSDC (settled)
                  • 11:14 propose_claim <TOKEN> ep5 (settled)
                  • ...

You → /protection <TOKEN>
@muhaven_bot → <TOKEN> DefaultProtection: active.
                  50bps reserve covers ~$250K notional.
```

### Position (2 tools — buy + claim only)

| Tool | What it does |
|---|---|
| `muhaven.position.buy` | Propose a Subscription buy. Tier-gated via OpenClaw three-tier classifier. |
| `muhaven.position.claim` | Propose a yield claim for one or more (token, epoch) tuples. |

**Example — a sub-$200 buy (tier 1, inline button):**

```
You → /buy 50 <TOKEN>

@muhaven_bot → You're about to buy 50 mhUSDC of <TOKEN>.
                  Quote: ~49.85 shares @ NAV $1.003
                  Tier:  Inline (≤$200)
                  [✅ Confirm]  [❌ Cancel]

You → (tap ✅ Confirm)

@muhaven_bot → ✅ Settled. Tx: 0xabc... (View on Arbiscan)
```

**Example — a claim of a single epoch:**

```
You → /claim <TOKEN> 7

@muhaven_bot → Claim <TOKEN> yield for epoch 7?
                  Estimated payout: $14.20 (encrypted)
                  Tier:  Inline (claim is fee-bearing pull)
                  [✅ Confirm]  [❌ Cancel]

You → (tap ✅ Confirm)

@muhaven_bot → ✅ Claimed. Tx: 0xdef...
```

For tier-2 ($200–$5K Mini-App OTP) and tier-3 (>$5K passkey deeplink) buys, the bot replaces the inline button with a Mini App launcher or a dashboard deeplink — see [Three confirmation tiers](/openclaw/confirmation-tiers).

### Policy (2 tools — pause + status only)

| Tool | What it does |
|---|---|
| `muhaven.policy.pause` | Activate the `/pause` kill-switch. Always allowed regardless of tier. |
| `muhaven.policy.session_key_status` | Inspect the ZeroDev session-key state. |

**Example — pause from anywhere:**

```
You → /pause

@muhaven_bot → ⏸ Agent paused.
                  On-chain validator uninstalled in block 8214321.
                  All propose tools will return 423 PAUSED.
                  To resume, open https://muhaven.app/agent and
                  complete the WebAuthn ceremony (Telegram can't
                  drive that — no browser).
```

**Example — session-key inspection before a big buy:**

```
You → /sessionkey

@muhaven_bot → Session key:
                  • Value cap per call: $5,000
                  • Value cap per epoch: $50,000
                  • Validity: 42 minutes remaining
                  • Target allowlist: 11 MuHaven contracts
                  Anything ≤$5K per call signs without re-prompt.
```

## What's deliberately excluded (11 tools)

| Excluded tool | Why excluded |
|---|---|
| `position.sell` | Multi-leg redemption queue ceremony doesn't fit a three-tier Telegram confirmation. |
| `position.rebalance` | Multi-leg multicall doesn't fit a single inline-button confirmation. |
| `policy.set_tier` | Tier transitions need the dashboard WebAuthn ceremony (Paused → any). |
| `policy.audit_export` | Audit export needs a download surface, not a Telegram message. |
| `issuer.distribute_yield` | OpenClaw skill is investor-only. |
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
2. **Investor-only on Telegram.** Issuer flows have stricter trust assumptions (issuer's MuHaven wallet signing) and benefit from the dashboard's full audit copilot rendering. They're available on HavenBot and MCP instead.
3. **Smaller attack surface.** The OpenClaw skill runs as a sandboxed binary with declared egress allowlist. The fewer tools in the catalog, the smaller the prompt-injection attack surface.

## How the subset is enforced

The skill's `src/index.ts` calls `runMcpStdioCli({ filterRegistry })` from `@muhaven/mcp/server.ts`. The filter is a synchronous callback that:

1. Receives the full 25-tool registry from the bundled MCP server.
2. Returns only the 11 tools in the `TOOLSET_SUBSET` set.
3. Refuses to start if the filtered registry is empty (sanity check against a typo'd subset).

The hash verification gate fires **before** the filter — so an attacker who patched a single descriptor cannot hide it by shipping a subset filter that excludes the patched tool. The descriptor is verified, *then* filtered. This is documented in `packages/openclaw-skill/src/index.ts` NatSpec.

## Where next

- [Playbook — phone-first scenarios](/openclaw/playbook) — full chat flows for commuting, claiming from bed, switching tiers on the train.
- [Telegram bot](/openclaw/telegram-bot) — the commands above in context.
- [Three confirmation tiers](/openclaw/confirmation-tiers) — how the tier classifier wraps each propose call.
- [Troubleshooting](/openclaw/troubleshooting) — common skill + bot issues.
