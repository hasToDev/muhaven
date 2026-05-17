---
layout: home
title: MuHaven Docs
titleTemplate: Confidential RWA, agentic-first

hero:
  name: MuHaven
  text: Confidential RWA, agentic-first.
  tagline: A real-world-asset portfolio you operate by asking. Encrypted on-chain. One passkey, one agent, four surfaces.
  image:
    src: /logo.png
    alt: MuHaven
  actions:
    - theme: brand
      text: Get started
      link: /get-started/quickstart
    - theme: alt
      text: Pick your agentic surface
      link: /get-started/choosing-a-surface
    - theme: alt
      text: View on GitHub
      link: https://github.com/hasToDev/muhaven

features:
  - icon: 🪙
    title: "HavenBot — in the dashboard"
    details: "Chat with the copilot at muhaven.app/agent. Cleartext previews, passkey confirmations, never holds your key."
    link: /havenbot/overview
    linkText: Open the HavenBot guide
  - icon: 🧩
    title: "@muhaven/mcp — bring your own LLM"
    details: "Install in Claude Code, Claude Desktop, or Cursor. Your LLM, your context, MuHaven's encrypted portfolio."
    link: /mcp/overview
    linkText: Install MCP
  - icon: 📨
    title: "OpenClaw + Telegram"
    details: "Phone-first UX. Three confirmation tiers — inline button, Mini App + OTP, passkey deep-link."
    link: /openclaw/overview
    linkText: Use Telegram
  - icon: 💳
    title: "Hosted Checkout"
    details: "One-click pay links for issuers. Buyers pay with a passkey on muhaven.app/pay — fragment-key URL keeps the operator blind."
    link: /checkout/overview
    linkText: Create a checkout link
---

<div style="padding: 0 24px 80px;">

## Built for people who don't want to think about wallets

MuHaven hides the chain. You sign in with a passkey, your balances are encrypted end-to-end with [Fhenix CoFHE](https://docs.fhenix.io), and an agent handles the rest — at the tier of autonomy *you* pick. Read-only? Confirm every move? Bounded automation? Your call.

<div class="mh-card-grid">
  <a class="mh-card" href="/get-started/quickstart">
    <h3>Quickstart</h3>
    <p>From passkey to first encrypted buy — across all four surfaces.</p>
  </a>
  <a class="mh-card" href="/policy/tiered-autonomy">
    <h3>Tiered autonomy</h3>
    <p>Advisory · Confirm-per-action · Policy-bound · Paused. Pick once, change anytime.</p>
  </a>
  <a class="mh-card" href="/policy/pause">
    <h3>The /pause kill-switch</h3>
    <p>One tap uninstalls the agent's on-chain validator in ≤1 Arbitrum block.</p>
  </a>
  <a class="mh-card" href="/reference/tool-catalog">
    <h3>Tool catalog</h3>
    <p>The 22 tools your agent can call, scoped by surface and tier.</p>
  </a>
</div>

## What "agentic-first" means here

Three constraints, simultaneously:

1. **You can drive everything by asking.** Portfolio summary, quote, buy, claim, set tier, pause — all expressed as natural language across four surfaces.
2. **No agent ever holds your key.** Your passkey signs; a scoped session key signs short-lived; an LLM never signs.
3. **Encrypted means encrypted.** Balances are FHE-encrypted on-chain. The agent reads aggregates and `ebool` flags. *You* decrypt locally via a permit when you need to see numbers.

</div>
