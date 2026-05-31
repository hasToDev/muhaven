---
title: Not in this guide
description: Features that exist in MuHaven but are deliberately excluded from the Testing Guide, and why.
---

# Not in this guide

MuHaven has a few surfaces that are **built but not part of this testing guide** — either
because they're still being hardened, or because the on-chain contracts behind them aren't
deployed on the demo testnet. We list them here so you know they exist and why we left
them out, rather than letting you hit a dead end mid-evaluation.

::: info These are intentionally out of scope — not bugs.
If you find one of these surfaces in the app, it works to the extent described below.
We just haven't written task-by-task test steps for it yet.
:::

## Hosted Checkout

**What it is:** one-click "pay with a passkey" links an issuer can share, so a buyer can
purchase a position without a full dashboard tour.

**Why it's excluded:** the checkout link / session flow is still in active development and
isn't ready for general testing. Architecture docs live under [Hosted Checkout](/checkout/overview).

## OpenClaw — Telegram bot & phone-first surfaces

**What it is:** a phone-first way to drive your portfolio — a Telegram bot, a device-link
flow (`/link`), and a high-value intent-confirmation deep-link (`/agent/confirm`).

**Why it's excluded:** these surfaces aren't ready for general testing yet. The in-dashboard
[HavenBot](/guide/agent/chat) and the [MCP server](/mcp/overview) cover the same agentic
capabilities for testing. Architecture docs live under [OpenClaw](/openclaw/overview).

## P11 — governance, default protection, cross-chain KYC

**What it is:** three later-wave features —

- **Encrypted governance** (propose / vote on encrypted ballots),
- **Default protection** (an issuer-funded coverage reserve), and
- **Cross-chain KYC attestation** (reuse a KYC claim across chains).

**Why it's excluded:** the contracts behind these are **not deployed on the demo
testnet**. The corresponding agent tools (`governance.propose`, `governance.cast_vote`,
`read.protection_coverage`, `read.kyc_attestation`) deliberately return a clear
**`not_deployed`** response so you can see the wiring exists without a half-working
feature. Treat these as *coming soon*.

---

Everything **else** — the full investor flow, the AI agent (including autonomous
execution), and the complete issuer journey — **is** covered. Head back to the
[Testing Guide overview](/guide/) to pick a track.
