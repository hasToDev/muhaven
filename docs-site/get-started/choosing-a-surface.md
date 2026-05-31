---
title: Choosing a surface
description: Decision tree for HavenBot vs MCP vs OpenClaw vs Hosted Checkout.
---

# Choosing a surface

MuHaven is architected around four agentic surfaces that share the same SDK and the same policy gate. Three are live today — **HavenBot**, **`@muhaven/mcp`**, and the **Telegram bot** — while the **OpenClaw skill** and **Hosted Checkout** are in development. You don't have to pick one — most users run two or three side by side. But there's a natural starting surface for any given context.

## Quick chooser

| If you… | Start with | Why |
|---|---|---|
| Are brand-new and want a guided UX | [**HavenBot**](/havenbot/overview) | Zero install, in-dashboard onboarding wizard, click-confirmable previews. |
| Already use Claude Code / Desktop / Cursor daily | [**`@muhaven/mcp`**](/mcp/overview) | Bring your own LLM; sit MuHaven next to your other MCP servers. |
| Live on your phone and want one-tap actions | [**OpenClaw + Telegram**](/openclaw/overview) | Phone-first UX, three confirmation tiers, no laptop needed. |
| Are an issuer minting a one-off buy URL for a non-customer | [**Hosted Checkout**](/checkout/overview) | Buyer doesn't need an account — provisions one via passkey at checkout. |

## Decision tree

```
                ┌─ "I want to drive everything from my phone."
                │  → OpenClaw + Telegram bot (chat with @muhaven_bot)
                │
                ├─ "I want to be the LLM owner. I already use Claude Code."
                │  → @muhaven/mcp (install in your host)
                │
Who are you? ───┤
                ├─ "I want to send a pay link to someone who doesn't have a MuHaven account."
                │  → Hosted Checkout (issuer-side create-link tool)
                │
                └─ "I just want to use MuHaven."
                   → HavenBot in the dashboard (default)
```

## Feature parity matrix

All four surfaces route through the same tools and the same policy gate. They differ in (1) which subset of tools they expose, (2) where confirmations happen, and (3) what host runtime they need. The matrix below describes the architected capabilities of each surface; the OpenClaw + Telegram column reflects the design for the OpenClaw skill (the Telegram bot itself is live, the broader OpenClaw skill is in development), and the Hosted Checkout column is in development.

| Capability | HavenBot | MCP | OpenClaw + Telegram | Hosted Checkout |
|---|---|---|---|---|
| Sign in with passkey | ✅ Dashboard | ✅ Device-flow + dashboard | ✅ Telegram link → dashboard | ✅ At checkout (first use) |
| Read portfolio | ✅ | ✅ | ✅ | ❌ |
| Read yields | ✅ | ✅ | ✅ | ❌ |
| Propose buy | ✅ | ✅ (envelope only) | ✅ (with tier-aware confirm) | ✅ (sole purpose) |
| Propose claim | ✅ | ✅ (envelope only) | ✅ | ❌ |
| Set tier / pause | ✅ | ✅ | ✅ | ❌ |
| Issuer: distribute yield | ✅ | ✅ | ⛔ (excluded from skill subset) | ❌ |
| Issuer: KYC add/remove | ✅ | ✅ | ⛔ | ❌ |
| Issuer: unpause new token | ✅ | ✅ | ⛔ | ❌ |
| Issuer: create checkout link | ✅ (via HavenBot tool) | ❌ | ❌ | ✅ (sole purpose; via HavenBot) |
| Audit log query | ✅ | ✅ | ✅ (read) | ❌ |
| Read-only mode | ❌ | ✅ `MUHAVEN_READ_ONLY=true` | n/a (skill subset) | n/a |
| Bring your own LLM | ❌ (Gemini today) | ✅ | n/a (no LLM at the bot edge) | n/a |

Legend: ✅ supported by design · ⛔ deliberately excluded · ❌ not applicable. (OpenClaw skill + Hosted Checkout are in development; the Telegram bot, HavenBot, and MCP are live.)

## Confirmation surface differences

The single biggest practical difference is **where you confirm**:

- **HavenBot** confirms in-modal in the same browser tab.
- **MCP** never auto-submits — it hands you an envelope and you confirm on the dashboard or in your host's UI (depending on host capability).
- **OpenClaw + Telegram** uses a **three-tier classifier** based on USD amount:
  - **≤ $200** → inline keyboard button right in the Telegram chat
  - **$200 – $5,000** → Telegram Mini App + 6-digit OTP
  - **> $5,000** → deep-link out to a passkey signature on the dashboard
- **Hosted Checkout** confirms with a passkey at `muhaven.app/pay/...` — the only surface designed for users who don't yet have a MuHaven account.

See [Three confirmation tiers](/openclaw/confirmation-tiers) for the Telegram classifier in detail.

## Can I use multiple surfaces?

Yes — and most users do. The four surfaces share **one** MuHaven wallet, **one** audit log, **one** tier setting, and **one** `/pause` kill-switch. Linking a new surface doesn't fork your identity or your state.

A common stack:

- **HavenBot** for ad-hoc dashboard work.
- **`@muhaven/mcp`** in Claude Code for cross-surface multi-agent workflows ("pull my portfolio + write a memo + email my CPA").
- **OpenClaw + Telegram** for one-tap actions on mobile.
- **Hosted Checkout** if you're an issuer.

The shared substrate ensures that:

- Pausing on one surface pauses *all* surfaces (the on-chain validator is uninstalled).
- A tier change on one surface applies everywhere.
- Every action on every surface writes to the same audit log.

## What to read next

- [HavenBot overview](/havenbot/overview)
- [MCP overview](/mcp/overview)
- [OpenClaw overview](/openclaw/overview)
- [Hosted Checkout overview](/checkout/overview)
- [Tiered autonomy](/policy/tiered-autonomy) — the policy substrate that ties all four together
