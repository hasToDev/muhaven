---
title: Let the agent read your data
description: Use HavenBot or your own LLM via MCP to read portfolio, yields, and activity safely.
---

# Let the agent read your data

<TaskMeta time="~3 min" role="Any signed-in user" needs="Signed in (MCP path also needs @muhaven/mcp linked to your account)" />

> **What you'll do:** Have the agent read your data two ways — through HavenBot, and through your own LLM using the `@muhaven/mcp` read tools.

## Before you begin
::: info Prerequisites
- Be signed in with your passkey.
- For the MCP path, link the **`@muhaven/mcp`** server to your account first — see the [MCP install guide](/mcp/install).
:::

## Steps
1. **In HavenBot:** at `/agent`, just ask — e.g. **"Show my activity"** or **"What's my best yield right now?"**.
2. **Via MCP:** point your own LLM (Claude Code / Claude Desktop / Cursor) at the `@muhaven/mcp` server and let it call the read tools directly.
3. The read tools are:
   - `muhaven.read.portfolio`
   - `muhaven.read.yields`
   - `muhaven.read.tokens`
   - `muhaven.read.activity`
   - `muhaven.read.audit`
   - `muhaven.read.distribution`
4. These are read-only and need **no confirmation** — no passkey prompt, no transaction.

::: important Reads never expose your cleartext balances
Read tools return **aggregates and encrypted handles**, never your cleartext private balances. The agent sees only what you've revealed plus encrypted values it cannot open.
:::

::: warning Two tools intentionally return `not_deployed`
`muhaven.read.protection_coverage` and `muhaven.read.kyc_attestation` return **`not_deployed`** on the demo testnet by design — those surfaces aren't part of this build. See [Not in this guide](/guide/not-in-this-guide).
:::

## Expected result
<ExpectedResult>
HavenBot (or your own LLM via MCP) returns your data — <strong>aggregates and encrypted handles only</strong> — with <em>no confirmation prompt and no on-chain transaction</em>.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| MCP tool calls fail to authenticate | The MCP server isn't linked to your account — follow [/mcp/install](/mcp/install). |
| `protection_coverage` / `kyc_attestation` returns `not_deployed` | Expected on the demo testnet — not a bug. See [Not in this guide](/guide/not-in-this-guide). |
| Balances look encrypted/opaque | That's the privacy model working — reveal a balance in the dashboard if you need cleartext. |

→ Next: [Set the agent's autonomy tier](/guide/agent/set-tier)
