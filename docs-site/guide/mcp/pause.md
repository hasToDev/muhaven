---
title: Pause / kill-switch via MCP
description: Pause the agent and revoke its on-chain signing rights from your own LLM, plus session status and audit export.
---

# Pause / kill-switch via MCP

<TaskMeta time="~2 min" role="Investor" needs="@muhaven/mcp logged in (M1), an active session to pause" />

> **What you'll do:** hit the panic button from your own LLM — pause the agent, check session status, and export the audit log.

## Before you begin
::: info Prerequisites
The `@muhaven/mcp` server logged in ([M1](/guide/mcp/install)), with an active agent session to stop. This is the MCP twin of [H6 · Pause / kill-switch](/guide/agent/pause) and [H7 · Session status + audit](/guide/agent/session-audit).
:::

## Steps
1. In your host, type **"Pause my muhaven agent."** → `muhaven.policy.pause`.
   - **Omit the surface** to cascade the pause across **all** agent surfaces; pass one to pause just that surface.
   - The surface is marked **Paused** immediately, and the tool returns an **unsigned UserOp** that uninstalls the agent's on-chain validator. Submit it with your **passkey** — signing rights are gone in **≤1 Arbitrum block**.
2. Ask **"What's my agent session status?"** → `muhaven.policy.session_key_status` — returns tier, validator address, valid-until, recent action count.
3. Ask **"Export my agent audit log."** → `muhaven.policy.audit_export` — streams your full tiered-autonomy log as one JSON document.
4. **To resume**, pick **Advisory** on the dashboard (`/agent/policy/transition` → **Resume to Advisory**) — there is no MCP `resume` tool.

::: important The panic button
`pause` marks the surface Paused instantly; submitting the returned UserOp with your passkey is what actually revokes the agent's signing rights on-chain.
:::

## Expected result
<ExpectedResult>
<code>muhaven.policy.pause</code> marks the surface <strong>Paused</strong> immediately and
returns an <strong>unsigned UserOp</strong>; after you submit it with your passkey the
agent's validator is uninstalled in <em>≤1 Arbitrum block</em>. <code>session_key_status</code>
and <code>audit_export</code> are read-only.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| Surface shows Paused but the agent still seems active | Submit the returned **unsigned UserOp** with your passkey to actually revoke signing rights. |
| `session_key_status` shows no active session | You haven't armed a Scoped session — see [M5](/guide/mcp/set-tier). |
| Need to bring the agent back | Resume needs a passkey — pick **Advisory** on the dashboard (**Resume to Advisory**); there is no MCP `resume` tool. |

→ Next: [Reference appendix](/guide/reference)
