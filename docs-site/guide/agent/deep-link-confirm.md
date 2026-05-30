---
title: Approve an action via deep-link
description: When the agent isn't autonomous, you sign each proposed action with your passkey (Path C).
---

# Approve an action via deep-link

<TaskMeta time="~2 min" role="Any signed-in user" needs="Signed in with your passkey" />

> **What you'll do:** Open an agent-proposed deep-link, review the cleartext preview, and authorize it with your passkey.

## Before you begin
::: info Prerequisites
Be signed in. This is the **Advisory / Confirm-per-action** flow (Path C) — used whenever the agent isn't acting autonomously. Both HavenBot and the MCP server can produce these deep-links.
:::

## Steps
1. Have the agent propose an action (e.g. a buy). It returns a **deep-link** into the dashboard, such as `/trade?mode=buy&…` or `/cash?…`.
2. Open the deep-link. A **ConfirmModal** mounts, showing a **cleartext preview** of exactly what will happen.
3. Review the preview, then tap **Authorize** and approve with your **passkey**.
4. The action executes on-chain (~30–60s; gas is sponsored).
5. Verify it in [Activity](/guide/investor/activity) or via `muhaven.read.activity`.

::: important The agent proposes — you are the signer
Nothing executes without your passkey. The agent can only hand you a deep-link with a preview; the signature is always yours.
:::

## Expected result
<ExpectedResult>
The <strong>ConfirmModal</strong> shows a cleartext preview matching what you asked for. After you <strong>Authorize</strong> with your passkey, the action lands on-chain and shows up in <a href="/guide/investor/activity">Activity</a> within ~30–60s.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| Deep-link opens but no modal appears | Make sure you're signed in on the same account; reopen the link. |
| Preview doesn't match your request | Don't authorize — close the modal and re-ask the agent for the correct action. |
| Passkey prompt never appears | Check your browser/device passkey support, then tap **Authorize** again. |

→ Next: [Pause the agent (kill-switch)](/guide/agent/pause)
