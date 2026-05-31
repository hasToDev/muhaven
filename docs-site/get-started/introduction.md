---
title: Introduction
description: What MuHaven is, why agentic, and how the four surfaces fit together.
---

# Welcome to MuHaven

MuHaven is a **confidential real-world-asset (RWA) portfolio**. Your token balances are encrypted on-chain with Fully Homomorphic Encryption ([Fhenix CoFHE](https://docs.fhenix.io)). You hold them in a passkey-bound **MuHaven wallet** (a ZeroDev-powered smart account, EIP-4337). And — the part this documentation focuses on — you operate the whole thing through one of four **agentic surfaces** that all talk to the same underlying SDK and the same on-chain policy gate.

## What "agentic" means in MuHaven

A regular LLM answers questions. An agent **does things**.

When you ask ChatGPT "what's the best RWA yield?", it answers. When you tell HavenBot *"buy $500 of `<TOKEN>` from a stablecoin position"*, it:

1. Reads current rates and the deviation-gated NAV.
2. Drafts an allocation and shows you the cleartext preview.
3. Waits for your passkey-confirmation (or a scoped session-key signature, depending on your tier).
4. Signs the UserOp and settles atomically through `MuHavenSubscription.purchase`.
5. Writes a row to your audit log.

Encrypted balances never leave your local decrypt permit. The LLM never holds your key. The agent never bypasses the policy gate.

## The four surfaces

Each surface is a different way to reach the **same** SDK and the **same** policy gate. Pick whichever matches where you already are.

| Surface | Where you use it | Best for |
|---|---|---|
| **[HavenBot](/havenbot/overview)** | In the MuHaven dashboard at `muhaven.app/agent` | Newcomers. Guided UX. Click-confirmable previews. |
| **[`@muhaven/mcp`](/mcp/overview)** | Claude Code, Claude Desktop, Cursor, or any MCP-aware host | Power users who already chat with their own LLM. |
| **[OpenClaw + Telegram](/openclaw/overview)** | Telegram (mobile-first) + the OpenClaw skill runtime | Phone-first investors. Three confirmation tiers. |
| **[Hosted Checkout](/checkout/overview)** | A pay-link an issuer shares (`muhaven.app/pay/...`) | One-off buyers. Pay with a passkey, no install. |

See [Choosing a surface](/get-started/choosing-a-surface) for a decision tree.

## What MuHaven is (and isn't)

**MuHaven is:**

- A confidential RWA portfolio with FHE-encrypted balances.
- A passkey-bound smart account — no seed phrase, no MetaMask popup, no private key on your device.
- A *tiered-autonomy* agent layer: you choose how much the agent can do without asking you each time.
- An on-chain policy gate that rejects any tool-call outside your declared scope. The LLM **proposes**; the gate **disposes**.

**MuHaven is not:**

- A financial advisor. Tools surface information; they don't recommend specific securities.
- A custodial wallet. You sign with your passkey; MuHaven never holds your key.
- A pure read-only dashboard. The four surfaces all support proposing and (with confirmation) executing real on-chain actions.

## What's available

MuHaven runs live on Arbitrum Sepolia (testnet); Arbitrum One (mainnet) is on the roadmap. Three surfaces are live today and two are in development:

**Live:**

- HavenBot at `muhaven.app/agent` — streaming chat, per-action ConfirmModal, a focused subset of the MCP toolset.
- `@muhaven/mcp` published on npm — install in any MCP host, 25 tools (8 read-only with the read-only flag).
- Telegram bot — live, phone-first investor flow.
- Tiered autonomy engine + audit log + `/pause` kill-switch.

**In development (not yet live):**

- OpenClaw skill (`muhaven-rwa-skill` on ClawHub) — design in progress.
- Hosted checkout at `muhaven.app/pay` — fragment-key URL scheme, AES-256-GCM payload, Stripe-pattern webhooks.

## Where next

<div class="mh-card-grid">
  <a class="mh-card" href="/get-started/quickstart">
    <h3>Quickstart</h3>
    <p>From passkey to first encrypted buy.</p>
  </a>
  <a class="mh-card" href="/get-started/choosing-a-surface">
    <h3>Choosing a surface</h3>
    <p>Decision tree: HavenBot vs MCP vs Telegram vs Checkout.</p>
  </a>
  <a class="mh-card" href="/get-started/privacy-boundary">
    <h3>Privacy boundary</h3>
    <p>What the operator sees, what the LLM sees, what stays encrypted.</p>
  </a>
  <a class="mh-card" href="/policy/tiered-autonomy">
    <h3>Tiered autonomy</h3>
    <p>How Advisory / Confirm / Policy-bound / Scoped autonomy actually work.</p>
  </a>
</div>
