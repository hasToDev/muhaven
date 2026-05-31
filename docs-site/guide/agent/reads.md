---
title: HavenBot reads your portfolio
description: Ask the in-dashboard HavenBot copilot to read portfolio, yields, and activity safely.
---

# HavenBot reads your portfolio

<TaskMeta time="~3 min" role="Any signed-in user" needs="Signed in with your passkey" />

> **What you'll do:** Have **HavenBot** read your data in plain language — portfolio, yields, and activity — using its read tools, with no signing.

## Before you begin
::: info Prerequisites
Be signed in with your passkey. This is the in-dashboard HavenBot flow; for the same reads from your own LLM, see [M2 · Read your portfolio via MCP](/guide/mcp/reads).
:::

## Steps
1. At `/agent`, just ask HavenBot in plain language — e.g. **"Show my activity"**, **"What's my best yield right now?"**, or **"Summarise my holdings, yields, and recent transactions."**
2. HavenBot reads the matching data for you — portfolio, yields, tokens, activity, the audit log, and distribution history.
3. Reads are **read-only** and need **no confirmation** — no passkey prompt, no transaction.

::: info Reads never expose your cleartext balances
HavenBot reads **aggregates and encrypted handles**, never your cleartext private balances. The agent sees only what you've revealed plus encrypted values it cannot open.
:::

::: warning Coverage & KYC reads are off on the demo testnet
If you ask about **protection coverage** or your **KYC attestation**, HavenBot reports those surfaces as **not deployed** on the demo testnet by design — they aren't part of this build. See [Not in this guide](/guide/not-in-this-guide).
:::

## Expected result
<ExpectedResult>
HavenBot returns your data — <strong>aggregates and encrypted handles only</strong> — with <em>no confirmation prompt and no on-chain transaction</em>.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| HavenBot says it can't see any holdings | A brand-new account has nothing to read yet — fund and buy first, then re-ask. |
| Coverage / KYC questions come back "not deployed" | Expected on the demo testnet — not a bug. See [Not in this guide](/guide/not-in-this-guide). |
| Balances look encrypted/opaque | That's the privacy model working — reveal a balance in the dashboard if you need cleartext. |

→ Next: [Arm Scoped autonomy](/guide/agent/set-tier)
