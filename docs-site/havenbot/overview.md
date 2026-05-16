---
title: HavenBot — overview
description: Your in-dashboard AI copilot for confidential RWA portfolio actions.
---

# HavenBot

HavenBot is MuHaven's **in-dashboard agent**. It lives at `muhaven.app/agent` and operates the same SDK + policy gate as every other surface, with a guided UX layered on top: streaming chat, per-action ConfirmModal, FHE-decrypted previews assembled in-browser.

It's the lowest-friction way to start using MuHaven agentically — no terminal, no install, no host config. Open the dashboard, sign in with your passkey, click **Agent**, and you're in.

## What HavenBot can do

**Read (no signing):**

- Portfolio summary with `ebool` signal flags (`isOverexposed`, `isUnderYield`).
- Quote at current NAV before purchase.
- Unseal a specific encrypted handle (decrypts client-side via your permit).
- Protection-coverage state for any RWA token.

**Propose (signed via passkey or session key):**

- Buy / claim / rebalance.
- Set tier (Advisory ↔ Confirm-per-action ↔ Policy-bound).
- Pause the agent (kill-switch).
- Encrypted governance vote (Wave 5 frontend runner).

**Issuer-only:**

- Distribute yield to a token's holders.
- Add / remove an investor from the KYC whitelist.
- Set initial NAV and unpause a freshly-deployed token.
- Query the issuer-side audit log.
- Create a hosted-checkout link.

A full table is on the [Tool catalog](/reference/tool-catalog) page.

## How HavenBot looks

The HavenBot UI sits in your dashboard:

```
┌──────────────────────────────────────────────────────────────┐
│ MuHaven                                          [⚙ Settings]│
├─────────────────┬────────────────────────────────────────────┤
│                 │  HavenBot                                  │
│  ▸ Portfolio    │  ─────────────────                         │
│  ▸ Deposit      │                                            │
│  ▸ Yields       │  You — 11:42                               │
│  ▸ Activity     │  Show my portfolio.                        │
│                 │                                            │
│  ▸ Agent ●      │  HavenBot — 11:42                          │
│                 │  You hold 3 RWA tokens. Status: balanced.  │
│  ─── Issuer ─── │  (encrypted-balance handle hidden)         │
│  ▸ Tokens       │                                            │
│  ▸ Distribute   │  You — 11:43                               │
│  ▸ Investors    │  Buy 50 mhUSDC of TBILL1.                  │
│  ▸ Compliance   │                                            │
│                 │  HavenBot — 11:43                          │
│                 │  ┌────────── ConfirmModal ──────────┐      │
│                 │  │ Buy 50.00 mhUSDC of TBILL1       │      │
│                 │  │ Estimated shares: ~49.85         │      │
│                 │  │ NAV: $1.003 · slippage 0.30%     │      │
│                 │  │ [Cancel]            [Confirm]    │      │
│                 │  └─────────────────────────────────┘       │
│                 │                                            │
└─────────────────┴────────────────────────────────────────────┘
```

Three things to note:

1. **Streaming responses** — replies tokenize live so you can interrupt or follow up.
2. **ConfirmModal** — every state-mutating action opens a cleartext-preview modal before signing. No silent execution, even in Confirm-per-action tier.
3. **In-line widgets** — portfolio cards, quote widgets, and signal flags render in-place instead of as raw JSON.

## The three components under the hood

```
Your message
       │
       ▼
┌──────────────────┐
│  HavenBot LLM    │  reads context (tier, recent audit, tool availability)
│  produces tool   │
│  intent JSON     │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│  Policy gate     │  tier check (Advisory/Confirm/Policy-bound)
│  (deterministic) │  @zerodev/permissions validator scope
│                  │  RiskParams encrypted threshold check
└──────┬───────────┘
       │ approved
       ▼
┌──────────────────┐
│  MuHaven SDK     │  kernel + session-key sender writes the UserOp
│  call            │  ZeroDev bundler relays
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│  Audit log       │  WORM append, permit-grant events recorded
└──────────────────┘
```

The **LLM never holds keys** and never directly invokes a wallet method. It produces structured tool-call intents; the policy gate is the only path to a signer.

A prompt-injection attempt that would have triggered an off-policy tool call is rejected by the gate before the intent reaches the signer. This is the **CaMeL planner/action split** — the planner LLM is kept out of the signing path entirely.

## Onboarding wizard

First-time visitors land on `/agent/onboarding` instead of `/agent` proper. The wizard is a four-step explainer:

1. Welcome (sealed-glass-envelope copy).
2. Funding (faucet for testnet; on-ramp for production).
3. First buy (pick a token, set an amount, confirm).
4. Celebrate (set tier, link Telegram, install MCP).

Returning users skip past steps they've already completed — a `muhaven:onboarding:complete` localStorage flag plus a backend portfolio probe gates the wizard so it doesn't re-prompt you on repeat visits.

Read the full walkthrough at [Onboarding](/havenbot/onboarding).

## Privacy properties

- Your encrypted balances stay on-chain as ciphertext. HavenBot reads aggregates and `ebool` flags. Cleartext previews are assembled in your browser via `decryptForView(handle).withPermit().execute()` — the backend doesn't see them.
- The LLM provider (Gemini today, swappable to Claude in Wave 5) sees your chat transcript and the tool-call envelopes. It does NOT see raw FHE handles.
- The chat history is server-managed for now. You can clear it from `/agent → ⋯ menu → Clear chat`. Wave 5 may add a "keep local only" mode.
- Every state-mutating tool emits an audit log row. Read tools intentionally do not log (privacy floor) — see [Audit log](/policy/audit-log).

## When to use HavenBot

✅ You're new to MuHaven and want the guided UX.
✅ You like click-confirmable previews.
✅ You don't have or want a separate MCP host.
✅ You're an issuer and want the in-product audit copilot.
✅ You want the lowest-friction surface — open dashboard, ask, done.

❌ You want to bring your own LLM (use [MCP](/mcp/overview)).
❌ You're on a phone and want one-tap actions (use [Telegram](/openclaw/telegram-bot)).
❌ You're an issuer minting a one-off pay link for someone without a MuHaven account (use [Hosted Checkout](/checkout/overview)).

## Where next

<div class="mh-card-grid">
  <a class="mh-card" href="/havenbot/onboarding">
    <h3>Onboarding</h3>
    <p>Under 6 minutes from passkey to first encrypted buy.</p>
  </a>
  <a class="mh-card" href="/havenbot/conversations">
    <h3>Conversations & confirmations</h3>
    <p>How the chat, ConfirmModal, and signing flow actually work.</p>
  </a>
  <a class="mh-card" href="/havenbot/investor-playbook">
    <h3>Investor playbook</h3>
    <p>Phrasing that works for buy, claim, rebalance, set policy.</p>
  </a>
  <a class="mh-card" href="/havenbot/issuer-playbook">
    <h3>Issuer playbook</h3>
    <p>Distribute yield, manage KYC, unpause a token, create checkout links.</p>
  </a>
</div>
