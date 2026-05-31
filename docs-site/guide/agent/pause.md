---
title: Pause the agent (kill-switch)
description: Instantly pause an agent surface and revoke its on-chain signing rights in one call.
---

# Pause the agent (kill-switch)

<TaskMeta time="~1 min" role="Any signed-in user" needs="Signed in, with an active session to pause" />

> **What you'll do:** Hit the panic button — pause the agent and uninstall its on-chain validator so its signing rights are gone in ≤1 block.

## Before you begin
::: info Prerequisites
Be signed in, with an active agent session you want to stop.
:::

## Steps
1. Call the MCP tool `muhaven.policy.pause`.
   - **Omit the surface** to cascade the pause across **all** agent surfaces.
   - **Pass a surface** to pause just that one.
2. The surface is immediately marked **Paused**, and the tool returns an **unsigned UserOp** that uninstalls the agent's on-chain validator.
3. Submit that UserOp with your **passkey**. The agent's signing rights are gone in **≤1 Arbitrum block**.
4. To resume later, pick the **Advisory** tier on `/agent/policy/transition` (it has a **Resume to Advisory** control — there is no MCP `resume` tool).

::: important The panic button
One call stops everything. Marking **Paused** is immediate; submitting the returned UserOp with your passkey is what actually revokes the agent's signing rights on-chain.
:::

## Expected result
<ExpectedResult>
The targeted surface (or all surfaces) shows <strong>Paused</strong> right away. After you submit the returned <strong>unsigned UserOp</strong> with your passkey, the agent's validator is uninstalled and its signing rights are gone in <em>≤1 Arbitrum block</em>.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| Surface shows Paused but agent still seems active | Submit the returned **unsigned UserOp** with your passkey to actually revoke signing rights. |
| Want to pause only one tool surface | Pass that surface to `muhaven.policy.pause` instead of omitting it. |
| Need to bring the agent back | Select **Advisory** on `/agent/policy/transition` (click **Resume to Advisory**) — there is no MCP `resume` tool. |

→ Next: [Inspect the agent's session & audit log](/guide/agent/session-audit)
