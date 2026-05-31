---
title: Read your portfolio via MCP
description: Ask your own LLM to read portfolio, yields, and activity through the @muhaven/mcp read tools.
---

# Read your portfolio via MCP

<TaskMeta time="~2 min" role="Investor" needs="@muhaven/mcp installed & logged in (M1)" />

> **What you'll do:** ask your own LLM host to read your portfolio, yields, and activity — these are read-only, so nothing signs.

## Before you begin
::: info Prerequisites
The `@muhaven/mcp` server installed and logged in — see [M1 · Install & verify the MCP server](/guide/mcp/install). For the same reads inside the dashboard, see the HavenBot equivalent [H2 · Agent reads your portfolio](/guide/agent/reads).
:::

## Steps
1. In your host, type a plain-language request — e.g. **"What does my muhaven portfolio look like?"** or **"What's my best yield right now?"** or **"Show my recent activity."**
2. Your LLM calls the matching read tool:
   - "portfolio" → `muhaven.read.portfolio`
   - "yields" → `muhaven.read.yields`
   - "activity" → `muhaven.read.activity`
3. These tools are **read-only** — no confirmation, no passkey prompt, no transaction.

::: important Reads never expose your cleartext balances
Read tools return **aggregates and encrypted handles**, never your cleartext private balances. Your LLM sees only what you've revealed in the dashboard plus encrypted values it cannot open.
:::

## Expected result
<ExpectedResult>
Your LLM makes a <code>muhaven.read.*</code> tool call and answers in plain language with
<strong>aggregates and encrypted handles only</strong> — <em>no confirmation prompt and no
on-chain transaction</em>.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| Tool calls fail to authenticate | Your JWT lapsed (~1h) — run `muhaven-broker login`. See [M1](/guide/mcp/install). |
| The host doesn't offer the read tools | Restart the host and confirm the `muhaven` server is listed (see [M1](/guide/mcp/install)). |
| Balances look opaque | That's the privacy model — reveal a balance in the dashboard ([I6](/guide/investor/reveal-balance)) if you need cleartext. |

→ Next: [Buy a position via MCP](/guide/mcp/buy)
