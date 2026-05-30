---
title: Chat with HavenBot
description: Ask the in-dashboard AI agent about your portfolio and yields in plain language.
---

# Chat with HavenBot

<TaskMeta time="~2 min" role="Any signed-in user" needs="Signed in with your passkey" />

> **What you'll do:** Open HavenBot and ask it to summarise your portfolio — a pure read that runs instantly with no signing.

## Before you begin
::: info Prerequisites
You must be signed in with your passkey. No tokens, balances, or session keys are required for this read-only first test.
:::

## Steps
1. Go to `/agent` to open the **HavenBot** chat.
2. Type a natural-language request, for example **"Summarise my portfolio"**.
3. Send it and read the reply.
4. Try a follow-up like **"What are my best yields?"** to see it pull live yield data.

::: tip HavenBot is not just advisory
HavenBot actually *calls tools*. For answers it uses read tools (portfolio, yields, tokens, activity, audit). When you ask it to act, it uses `propose_*` tools (buy, sell, claim, rebalance) that surface a **confirmation card** rather than executing silently.
:::

::: important Your key stays yours
HavenBot works on encrypted aggregates plus the numbers you've explicitly revealed. It **never holds your passkey or private key** — it can only read, propose, or act through flows you authorize.
:::

## Expected result
<ExpectedResult>
HavenBot replies with a <strong>plain-language summary of your portfolio</strong>. The answer appears <em>instantly</em>, with no passkey prompt and no on-chain transaction — because summarising is a pure read.
</ExpectedResult>

## If something goes wrong
| Symptom | Fix |
|---|---|
| `/agent` redirects you to sign in | Sign in with your passkey first, then reopen `/agent`. |
| Reply says it can't see any holdings | A brand-new account has nothing to summarise yet — fund and buy first, then re-ask. |
| A proposed buy/sell didn't execute | That's expected — `propose_*` tools only surface a confirmation card. You still confirm before anything runs. |

→ Next: [Let the agent read your data](/guide/agent/reads)
