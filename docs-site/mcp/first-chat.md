---
title: '@muhaven/mcp — first chat'
description: A walk-through from "show my portfolio" to a signed buy.
---

# Your first chat

Assuming you've completed [Install](/mcp/install) and `muhaven-broker doctor` shows a valid JWT, you're ready to ask your LLM about MuHaven. The walkthrough below uses Claude Code; the others are identical except for how the tool result renders.

## 1. A read-only question

```
> What does my muhaven portfolio look like?

I'll check your MuHaven portfolio.

[muhaven] muhaven.read.portfolio()
{
  "positions": [
    { "token": "RWA1", "asset_class": "treasury", "encrypted": true },
    { "token": "RWA2",  "asset_class": "gold",     "encrypted": true }
  ],
  "total_tokens": 2,
  "last_synced": "2026-05-16T10:32:14Z"
}

You hold 2 RWA tokens — RWA1 (treasury) and RWA2 (gold).
The actual balances are FHE-encrypted on-chain; if you want the
cleartext amounts, run `muhaven.read.portfolio` from your
dashboard at muhaven.app where you can decrypt locally with your
permit.
```

**What just happened:**

1. Claude saw your message + the MCP tool catalog and decided `muhaven.read.portfolio` was the right call.
2. The MCP server forwarded the call to the MuHaven backend with your JWT.
3. The backend returned the **aggregate** — token list + asset class + the boolean `encrypted: true`.
4. **No encrypted handle, no cleartext amount.** The privacy invariant holds across the LLM context.

## 2. A yield query

```
> How much yield did my RWA2 earn last quarter?

[muhaven] muhaven.read.yields({"token":"RWA2","since":"2026-02-01T00:00:00Z"})
{
  "token": "RWA2",
  "epochs": [
    { "id": 4, "distributed_at": "2026-02-15T14:00:00Z", "per_share_usd6": 1200 },
    { "id": 5, "distributed_at": "2026-03-15T14:00:00Z", "per_share_usd6": 1180 },
    { "id": 6, "distributed_at": "2026-04-15T14:00:00Z", "per_share_usd6": 1340 },
    { "id": 7, "distributed_at": "2026-05-15T14:00:00Z", "per_share_usd6": 1290 }
  ]
}

RWA2 paid yield over the last quarter:
- Feb epoch: $0.0012 / share
- Mar epoch: $0.00118 / share
- Apr epoch: $0.00134 / share
- May epoch: $0.00129 / share

Annualized, that's roughly 1.5% yield. Want me to claim any
unclaimed amounts? I can call muhaven.position.claim with the
epoch IDs.
```

## 3. A propose-only buy

```
> Buy 100 mhUSDC of RWA1.

[muhaven] muhaven.position.buy({"token":"RWA1","amountUsd6":100000000})
{
  "envelope": {
    "to": "0x4f...",
    "data": "0x9a3b...",
    "value": "0x0"
  },
  "broker_signature": "0xabc...",
  "tier_check": "ok",
  "audit_id": "agt_01HMTV..."
}

I've prepared a buy of 100 mhUSDC of RWA1. I have NOT submitted
it — MCP propose tools never auto-submit. Here's what you do:

1. Open https://muhaven.app/agent
2. You'll see this proposal pending in HavenBot
3. Confirm with your passkey

Or use the dashboard's /policy page to inspect the envelope
manually.
```

**What just happened:**

1. Claude called `muhaven.position.buy` with a structured argument.
2. The backend ran the tool through the policy gate → cleared.
3. The broker signed a session-key authorization → returned both the unsigned UserOp envelope and the broker's session-key signature.
4. **The MCP server returned the envelope and the signature — it did NOT submit to a bundler.** The host LLM is expected to surface the result to you for explicit confirmation through the dashboard or a host-presented review.

This is the **no-auto-submit invariant**. A jailbroken LLM cannot drain your account because position / policy / issuer / governance tools never call any bundler. Final commit ceremony for value-moving actions always walks through the passkey-bound dashboard or a tier-aware confirmation surface.

## 4. Pause

```
> Pause my agent.

[muhaven] muhaven.policy.pause()
{
  "result": "paused",
  "block": 8214321,
  "block_time_ms": 240,
  "audit_id": "agt_01HMTV..."
}

Your agent is paused. The on-chain session-key validator was
uninstalled in block 8214321 (~240ms). Subsequent propose calls
will return 423 PAUSED until you resume from the dashboard.
```

Pause is the **one** state-mutating tool that always submits (because the kill-switch should be one-shot). It's idempotent and always allowed regardless of tier.

To resume:

```
> Resume my agent.

[muhaven] You'll need to do that from the dashboard at
  https://muhaven.app/agent — resume requires a fresh passkey
  signature to install a new session-key validator. MCP can't
  drive the WebAuthn ceremony from here.
```

The resume path involves a WebAuthn passkey ceremony that the MCP server can't drive (no DOM, no browser). Resume on the dashboard, then come back to MCP.

## What you can't do via MCP

- **Decrypt encrypted handles.** MCP returns aggregates; cleartext decrypt requires the dashboard `decryptForView` path because the permit needs your browser-side cofhe client.
- **Resume after pause.** The WebAuthn ceremony is dashboard-only.
- **First-time onboarding.** The `/agent/onboarding` wizard is dashboard-only. MCP assumes you already have a MuHaven wallet; if you don't, sign up on the dashboard first.

## Where next

- [Playbook — scenarios](/mcp/playbook) — multi-MCP workflows, scheduled checks, cross-tool prompts.
- [Tool catalog](/mcp/tools) — the full schema for every tool.
- [Read-only mode](/mcp/read-only-mode) — restrict your MCP install to the 7 read tools.
- [Troubleshooting](/mcp/troubleshooting) — auth, transport, lifecycle issues.
