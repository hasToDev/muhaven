---
title: Inspect the agent's session & audit log
description: See what the agent is allowed to do and everything it has done — read-only and exportable.
---

# Inspect the agent's session & audit log

<TaskMeta time="~2 min" role="Any signed-in user" needs="Signed in with your passkey" />

> **What you'll do:** Check the agent's current permissions and export a full audit log of every autonomous action.

## Before you begin
::: info Prerequisites
Be signed in. Both tools below are read-only and need no confirmation.
:::

## Steps
1. Call `muhaven.policy.session_key_status` to see the current state:
   - the current **tier**
   - the **validator address**
   - the **valid-until** timestamp
   - a recent **action count**
2. Call `muhaven.policy.audit_export` to stream your full tiered-autonomy audit log to a single **JSON** document.
3. (Optional) Browse individual audit entries via `muhaven.read.audit`.

::: important Full transparency
Every autonomous action is logged and exportable. These reads expose what the agent *can* do and what it *has* done — without any confirmation prompt or transaction.
:::

## Expected result
<ExpectedResult>
<code>session_key_status</code> returns the <strong>tier, validator address, valid-until timestamp, and recent action count</strong>; <code>audit_export</code> streams your <strong>complete audit log as one JSON document</strong>. No passkey prompt, no transaction.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| `session_key_status` shows no active session | You haven't granted a Scoped session — see [Set the agent's autonomy tier](/guide/agent/set-tier). |
| `valid-until` is in the past | The session expired; grant a fresh one if you still want autonomy. |
| Audit export looks empty | The agent hasn't taken any autonomous actions yet — try [autonomous execution](/guide/agent/autonomous) first. |

→ Next: [Become an issuer](/guide/issuer/become-issuer)
