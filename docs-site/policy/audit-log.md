---
title: Audit log
description: What's recorded across surfaces, what's intentionally not.
---

# Audit log

Every state-mutating action on every agentic surface writes to a single **append-only WORM-style audit log**. The same `agent_audit_events` table backs HavenBot, MCP, OpenClaw, and the hosted-checkout issuer side.

Read tools intentionally **do not** log — that's a privacy floor. Forensic completeness for state-changing actions is the wall.

## What's logged

| Event type | When it fires | Carries |
|---|---|---|
| `propose_*` | LLM proposes an action (before user confirms) | tool name, args summary, action hash, requestedAtSec |
| `permit_granted` | User confirms; UserOp signed and submitted | tool name, surface, source, tx hash (after settlement) |
| `permit_attempted` | User confirms but UserOp failed (revert or timeout) | tool name, surface, source, error code |
| `tier_transition` | User changes their tier | from tier, to tier |
| `pause_triggered` | Pause cascade fires | manual / auto / breach |
| `pause_lifted` | Resume cascade fires | (manual only — auto-pauses require manual resume) |
| `breach_detected` | Policy-bound cron observes a threshold breach | breach type, encrypted handle (no cleartext) |
| `policy_template_built` | User mints a new session-key scope | scope summary, validity window |
| `device_code_consumed` | MCP device-flow login succeeds | client metadata, scope claims |
| `telegram_link_consumed` | Telegram bot `/link` succeeds | chat_id, user_id |
| `checkout_created` | Issuer mints a checkout | session_id, token, amount |
| `checkout_paid` | Buyer settles a checkout | session_id, buyer_wallet, tx_hash |
| `checkout_expired` | Session TTL elapses without payment | session_id |
| `checkout_cancelled` | Issuer cancels an unredeemed session | session_id |

## What's NOT logged

Deliberate omissions:

- **Read calls.** Reading your own portfolio, yields, audit, etc. emits no audit row. Tracking every "user looked at portfolio" turns the audit log into a surveillance ledger.
- **Encrypted balance handles.** Logged actions reference token addresses + the *fact* of a state mutation, not the encrypted amount.
- **Cleartext votes.** Encrypted governance votes log the *fact* of a vote (`permit_granted` row with `tool: 'governance.cast_vote'`) but not the cleartext yes/no.
- **LLM chat transcripts.** HavenBot's chat history is server-managed but separate from the audit log. You can clear chat without affecting audit.
- **Permit grant content.** A permit row says "permit minted for handle X with TTL Y"; it doesn't capture the resulting plaintext.

## Query interface

### Via HavenBot

> Show my agent audit log.
> Show audit rows from MCP in the last 7 days.
> Show only failed agent actions.
> Export my audit log.

### Via MCP

```ts
mcp.read.audit({ cursor: '...', limit: 50, filter: { surface: 'mcp' } })
```

Returns cursor-paginated rows. The cursor is a tuple `(createdAt, id)` for tie-breaking on burst writes that share a sub-ms `defaultNow()` timestamp (port-time fix from P1).

### Via dashboard

`/agent → Audit` opens a paginated table with filter chips for surface, tool, outcome, date range.

## Source attribution

Every `permit_granted` row carries a server-derived `source` field that says **how** the confirmation happened:

| `source` | Meaning |
|---|---|
| `dashboard_passkey` | Dashboard ConfirmModal + passkey ceremony |
| `dashboard_session_key` | Dashboard ConfirmModal + session-key signature (Confirm-per-action tier) |
| `policy_bound_cron` | Cron policy engine signed within bounds |
| `mcp_broker` | MCP propose → user confirmed on dashboard or host UI |
| `telegram_inline` | Telegram inline-button confirmation (tier 1 ≤$200) |
| `mini_app` | Telegram Mini App OTP confirmation (tier 2 $200-$5K) |

The `source` is **server-derived** from the auth path — investors and bot workers cannot spoof it. A `policy_bound_cron` row guarantees the cron actually signed (not just that you said it did).

## Append-only semantics

The `agent_audit_events` table is intentionally **append-only**:

- The Drizzle schema has no `updatedAt` column.
- The `IAgentAuditRepository` interface exposes only `append` + `findByUserId` (no update / delete).
- All writes go through `AppendAuditEventUseCase` — centralised.
- Database-level: `REVOKE UPDATE, DELETE ON agent_audit_events FROM muhaven_app` is set in the production deploy script.

The append-only property is the load-bearing forensic invariant: you (or a regulator, or a forensic reviewer) can replay the audit log and trust it wasn't tampered with after the fact.

## Cursor pagination

Pagination uses **tuple comparison** to avoid silently dropping rows that share a sub-ms timestamp:

```sql
WHERE (created_at > $cursor_at)
   OR (created_at = $cursor_at AND id > $cursor_id)
ORDER BY created_at ASC, id ASC
LIMIT $limit
```

A naive `gt(createdAt)` would lose rows on burst writes (e.g., the four-surface pause cascade). The tuple comparison is the safety net.

## Cross-user audit access (Wave 5)

Today, audit reads are **self-only**. A compliance officer can read their own audit; they cannot read another user's audit even with their consent.

Wave 5 adds **permit-gated cross-user audit access**:

- The audited user signs a permit granting read access (specific user, specific time window).
- The reading user passes the permit on the audit query.
- Backend verifies the permit against the on-chain ACL.
- Returns the rows.

The wire shape is pinned in **ADR-8 §D3**: the upgrade is **purely additive** (new optional `permit` request field; `scopedTo: 'self'` response field flips to a user-id when permit is present).

## Audit-log redaction (Wave 5)

A bounded leak in `agent_confirm_tokens.action_payload` exists today: for encrypted governance votes, the cleartext yes/no is stored for the 5-min confirm-token TTL so ConfirmModal can render the preview. After the TTL, the confirm token is purged.

This is acknowledged in [ADR-9 §D3](https://github.com/hasToDev/muhaven/blob/master/development/DEV_WAVE_4/ADR_LOG.md) as a Wave 5 redaction follow-up — the `action_payload` will be auto-redacted on permit_granted commit, leaving only the audit row (which records `tool: 'governance.cast_vote'` without the cleartext).

## Where next

- [Tiered autonomy](/policy/tiered-autonomy) — how tier transitions log.
- [The /pause kill-switch](/policy/pause) — pause cascade and audit rows.
- [Threat model in plain language](/policy/threats) — why audit completeness matters.
