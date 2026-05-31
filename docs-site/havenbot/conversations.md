---
title: HavenBot — conversations & confirmations
description: How chat, ConfirmModal, and signing fit together.
---

# Conversations & confirmations

HavenBot's conversation surface is **streaming chat** plus a per-action **ConfirmModal**. This page covers the round-trip from your message to a settled on-chain action.

## The full round-trip

```
1. You type a message.
2. Frontend opens a POST to /api/v1/agent/chat/stream (SSE).
3. Backend builds the LLM context (tier, recent audit, tool catalog).
4. LLM (Gemini) streams text and may emit a tool_call.
5. For each tool_call:
   a. Backend dispatches to the tool's use-case (read or propose).
   b. Read tools return data; the LLM streams a textual answer.
   c. Propose tools return an ActionDescriptor; the frontend opens ConfirmModal.
6. You confirm in ConfirmModal:
   a. Your MuHaven wallet + session key signs the UserOp.
   b. ZeroDev bundler relays.
   c. Settlement settles on Arb Sepolia.
7. Frontend POSTs /api/v1/agent/tools/commit with the action hash.
8. Backend writes the audit row.
9. HavenBot replies with a confirmation line in chat.
```

The two wire shapes that matter:

- **Read** — tool_call → data → LLM textual answer. No signing.
- **Propose** — tool_call → ActionDescriptor → ConfirmModal → user-driven sign → commit → audit.

## Streaming behavior

Replies tokenize live. You'll see:

- A typing indicator the moment you submit.
- Text streamed token-by-token (typically 30-80 tokens/sec).
- Tool widgets (portfolio card, quote box) rendered in-line once the tool call resolves.
- The ConfirmModal opening (if applicable) right after the tool result returns.

You can interrupt at any point with the **Stop** button. The backend cancels the upstream LLM stream; partial tool calls are discarded. No state changes on interrupt.

## The ConfirmModal

Every state-mutating action opens a ConfirmModal. The modal renders:

```
┌──────────────────────────────────────────────────────┐
│  ✦ Buy 50.00 mhUSDC of <TOKEN>                       │
├──────────────────────────────────────────────────────┤
│                                                      │
│  You're spending      50.00 mhUSDC                   │
│  You'll receive       ~49.85 <TOKEN> (encrypted)     │
│  Current NAV          $1.003                         │
│  Slippage             0.30% max                      │
│                                                      │
│  ──────────────────────────────────────────────      │
│                                                      │
│  Signing as           0x1234…cdef                    │
│  Session key TTL      52 minutes remaining           │
│                                                      │
│  [Cancel]                              [Confirm]     │
└──────────────────────────────────────────────────────┘
```

Two terminal states:

1. **Success** — toast "Settled" + Arbiscan link. Modal closes.
2. **Error** — toast with the revert reason. Audit log records a `PermitAttempted` row (failed-attempt forensic).

## Signing — passkey vs session key

Your MuHaven wallet has two signers:

1. **Master passkey** — your WebAuthn credential. Used at sign-in, for MuHaven wallet rebind, and for high-stakes confirmations.
2. **Session key** — a short-lived (default 1h) ECDSA key with **narrow scope** (only MuHaven functions, only your wallet, only for the session). Installed by your passkey at sign-in; uninstalled by `/pause`.

In Advisory tier, every action prompts your passkey. In Confirm-per-action tier, the session key signs without re-prompting the passkey for the session duration (you still confirm each action). In **Scoped autonomy** — the live autonomous tier — a bounded session key held by the broker daemon signs the agent's buys, sells, and claims without prompting you, up to a per-trade cap and until the TTL expires. **Policy-bound** is a designed automation tier whose encrypted-threshold auto-signing cron is built but disabled in every deployment, so it does not auto-sign today.

See [Session keys](/policy/session-keys) for the full scope spec.

## Read-tool widgets

Some tool results render as in-line widgets instead of raw text:

| Tool | Widget |
|---|---|
| `muhaven_portfolio_summary` | Portfolio card with token list, signal flags, "balanced/overexposed" pill |
| `muhaven_quote` | Quote box with NAV, slippage, estimated shares |
| `muhaven_unseal_position` | Cleartext balance bubble (decrypted client-side via permit) |
| `muhaven_audit_query` | Compact audit table, last 10 rows + pagination |

Widget rendering is opt-in per tool — the LLM can also produce a textual answer if the widget surface is wrong for the question.

## Chat history

Your chat history is **server-managed**:

- Stored against your user ID on the MuHaven backend.
- Pulled into the LLM context for follow-up turns within the same session.
- Cleared by `/agent → ⋯ menu → Clear chat`.

::: warning Don't paste secrets in chat
The chat history is plaintext on the backend. Never paste a private key, an API token, or any cleartext encrypted-balance value into the chat. (HavenBot has no use for them and the policy gate doesn't accept them anyway.)
:::

## Multi-turn behavior

The current chat loop is **single-turn**: text → tool_call → tool_result → done. If you want a follow-up reasoning step ("now that you've shown me the portfolio, recommend a buy"), send a second message.

## What HavenBot won't do

- **Sign without showing you the preview in an interactive session.** Every interactive action opens the ConfirmModal. (Scoped autonomy is the exception by design: once you've armed a bounded session key with a per-trade cap + TTL, the broker daemon signs buys/sells/claims within those bounds without a per-action prompt — that's the whole point of the autonomous tier.)
- **Submit a tool call that the policy gate rejected.** A jailbreak that fabricates "approved" in the LLM response cannot bypass the deterministic gate.
- **Decrypt your balance server-side.** All `decryptForView` calls run in your browser with your local permit.
- **Hold your private key.** The MuHaven wallet + session key are signers; the LLM is not.

## Where next

- [Investor playbook](/havenbot/investor-playbook) — phrasing that works.
- [Issuer playbook](/havenbot/issuer-playbook) — distribute yield, KYC churn, unpause.
- [Tiered autonomy](/policy/tiered-autonomy) — how Advisory / Confirm / Policy-bound / Scoped autonomy interact with ConfirmModal.
