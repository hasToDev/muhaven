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
1. At `/agent`, just ask HavenBot — e.g. **"Show my activity"** or **"What's my best yield right now?"**.
2. Under the hood HavenBot calls the read tools:
   - `muhaven.read.portfolio`
   - `muhaven.read.yields`
   - `muhaven.read.tokens`
   - `muhaven.read.activity`
   - `muhaven.read.audit`
   - `muhaven.read.distribution`
3. These are read-only and need **no confirmation** — no passkey prompt, no transaction.

::: important Reads never expose your cleartext balances
Read tools return **aggregates and encrypted handles**, never your cleartext private balances. The agent sees only what you've revealed plus encrypted values it cannot open.
:::

::: warning Two tools intentionally return `not_deployed`
`muhaven.read.protection_coverage` and `muhaven.read.kyc_attestation` return **`not_deployed`** on the demo testnet by design — those surfaces aren't part of this build. See [Not in this guide](/guide/not-in-this-guide).
:::

## Expected result
<ExpectedResult>
HavenBot returns your data — <strong>aggregates and encrypted handles only</strong> — with <em>no confirmation prompt and no on-chain transaction</em>.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| HavenBot says it can't see any holdings | A brand-new account has nothing to read yet — fund and buy first, then re-ask. |
| `protection_coverage` / `kyc_attestation` returns `not_deployed` | Expected on the demo testnet — not a bug. See [Not in this guide](/guide/not-in-this-guide). |
| Balances look encrypted/opaque | That's the privacy model working — reveal a balance in the dashboard if you need cleartext. |

→ Next: [Set the agent's autonomy tier](/guide/agent/set-tier)
