---
title: OpenClaw + Telegram — overview
description: Phone-first MuHaven via OpenClaw skill and the MuHaven Telegram bot.
---

# OpenClaw + Telegram

::: warning 🚧 In development — not in the Testing Guide
The OpenClaw Telegram bot, device-link (`/link`), and intent-confirm
(`/agent/confirm`) surfaces aren't ready for general testing yet, so they're excluded from the
[Testing Guide](/guide/). These pages describe the intended design. The same
agentic capabilities are testable today via [HavenBot](/havenbot/overview) and
the [MCP server](/mcp/overview).
:::

The OpenClaw surface is MuHaven's **phone-first** interface. It bundles three things:

1. **`muhaven-rwa-skill`** — an [OpenClaw](https://openclaw.dev) skill (in development; not yet published). Once published, you install it into your OpenClaw runtime; the skill bundles `@muhaven/mcp` with an investor-only subset (11 of 25 tools).
2. **`@muhaven_bot`** — the official MuHaven Telegram bot (live). Conversational interface for the same 11 tools.
3. **Telegram Mini App** — the in-Telegram web view that handles mid-tier confirmations (the $200-$5K window); part of the in-development OpenClaw mid-tier flow.

All three share the same MuHaven wallet and the same audit log as HavenBot, MCP, and the hosted checkout.

## What's available

The **Telegram bot is live** — one of MuHaven's three live surfaces (HavenBot, `@muhaven/mcp`, Telegram). The **OpenClaw skill** and the **Telegram Mini App** are still in development.

| Component | Status |
|---|---|
| `muhaven-rwa-skill` (OpenClaw skill) | In development — not yet published |
| `@muhaven_bot` Telegram bot | Live on Arbitrum Sepolia (testnet) |
| Telegram Mini App | In development (mid-tier confirmation UI) |
| Three-tier confirmation classifier | Inline ≤$200 / Mini-App OTP $200–$5K / passkey deeplink >$5K |
| Sigstore + GitHub OIDC publish | Trusted publisher configured; tag-push will trigger a signed release |

## The 11-tool subset (and what's deliberately excluded)

The OpenClaw skill includes:

- **All 5 read tools** — `portfolio`, `yields`, `distribution`, `tokens`, `audit`.
- **The 2 protection / KYC read tools** — `protection_coverage`, `kyc_attestation`.
- **2 of 4 position tools** — `buy`, `claim`.
- **2 of 4 policy tools** — `pause`, `session_key_status`.

Deliberately excluded:

- `position.sell` and `position.rebalance` — multi-leg ceremonies don't fit a three-tier Telegram confirmation.
- `policy.set_tier` and `policy.audit_export` — tier transitions need the dashboard ceremony; audit export needs a download surface.
- All 5 `issuer.*` tools — Telegram is investor-only.
- Both `governance.*` tools — encrypted vote ceremony needs the cofhe SDK in a browser; Telegram can't drive it.

If you need the excluded tools, use [HavenBot](/havenbot/overview) or [`@muhaven/mcp`](/mcp/overview).

## The three confirmation tiers

The classifier is **pure** — it takes the USD amount and returns one of three tiers:

| USD amount (mhUSDC) | Tier | Surface |
|---|---|---|
| ≤ $200 | **Inline** | Telegram inline keyboard button → tap → done |
| $200 – $5,000 | **Mini-App OTP** | Telegram Mini App opens → 6-digit OTP delivered out-of-band → enter → confirm |
| > $5,000 | **Passkey deeplink** | Telegram deep-link → opens dashboard `/agent/confirm` → passkey signature |

The classifier is **locked at the type level** — investors cannot raise the boundaries above the hardcoded ceilings (Reg BI Care Obligation framing).

Each tier emits a different audit-log `source` so you can tell which surface drove a given commit:

- `inline` → `telegram_inline`
- `mini-app` → `mini_app`
- `deeplink` → `dashboard_passkey`

See [Three confirmation tiers](/openclaw/confirmation-tiers) for the full flow per tier.

## How OpenClaw fits in

[OpenClaw](https://openclaw.dev) is an open standard for agent skills — bundled MCP servers + a manifest that declares network egress, secret storage, and tool subset. The MuHaven skill (`muhaven-rwa-skill`) is in development; once published it will live on [ClawHub](https://clawhub.com) (the central skill registry).

When you install the skill, the OpenClaw runtime:

1. Verifies the skill's Sigstore signature against the GitHub OIDC issuer.
2. Validates the manifest's `network.egress_allowlist` (only `api.muhaven.app` + `muhaven.app`).
3. Starts the bundled `@muhaven/mcp` server with the 11-tool subset filter.
4. Wires the broker daemon for signing.

The runtime enforces the manifest's permissions — even if a malicious LLM tried to call `position.sell`, the skill subset filter would refuse to register it.

## How the Telegram bot fits in

The Telegram bot is a **separate runtime** from the OpenClaw skill — they don't share processes. The bot is a small Express service that:

1. Listens on an outbound webhook for Telegram updates.
2. Validates Telegram's `initData` HMAC against the bot token.
3. For each command, calls the same backend HTTP routes the MCP / HavenBot surfaces use.
4. Renders the response as Telegram messages, inline buttons, or Mini-App launches.

The bot **does not run an LLM** — it's a deterministic command interpreter. The bot edge sees your Telegram chat ID and the inline button you tapped; it never sees an LLM context.

## When to use OpenClaw + Telegram

| Question | If yes → OpenClaw |
|---|---|
| Do you primarily work from a phone? | ✅ |
| Do you want one-tap actions for sub-$200 buys? | ✅ |
| Do you want the dashboard's passkey ceremony for big trades? | ✅ (the >$5K tier deeplinks to it) |
| Do you need issuer tools? | ❌ Use [HavenBot](/havenbot/overview) — Telegram is investor-only |
| Do you want to bring your own LLM? | ❌ Use [MCP](/mcp/overview) — Telegram has no LLM edge |
| Do you want multi-leg rebalances? | ❌ Use [HavenBot](/havenbot/overview) — rebalance is excluded from the skill subset |

## Where next

<div class="mh-card-grid">
  <a class="mh-card" href="/openclaw/install-skill">
    <h3>Install the skill</h3>
    <p>Get muhaven-rwa-skill running in OpenClaw.</p>
  </a>
  <a class="mh-card" href="/openclaw/telegram-bot">
    <h3>Telegram bot</h3>
    <p>Link your Telegram, send your first command.</p>
  </a>
  <a class="mh-card" href="/openclaw/confirmation-tiers">
    <h3>Three confirmation tiers</h3>
    <p>How inline / Mini App / passkey deeplink actually work.</p>
  </a>
  <a class="mh-card" href="/openclaw/tools">
    <h3>Available tools</h3>
    <p>The 11-tool subset, what each does, and how to invoke it.</p>
  </a>
  <a class="mh-card" href="/openclaw/playbook">
    <h3>Playbook — phone-first scenarios</h3>
    <p>Commuting check-in, claim from bed, train-station tier switch.</p>
  </a>
</div>
