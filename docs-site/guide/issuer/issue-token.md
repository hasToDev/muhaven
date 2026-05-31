---
title: Issue a token
description: Deploy a new confidential RWA token from the issuer wizard.
---

# Issue a token

<TaskMeta time="~3 min" role="Issuer" needs="Approved issuer" />

> **What you'll do:** Define a new RWA token's economics and deploy its on-chain stack.

## Before you begin

::: info Prerequisites
- You're an **approved issuer** — see [Become an issuer](/guide/issuer/become-issuer).
- Gas is sponsored, so you don't need any ETH.
:::

## Steps

1. Open `/tokens/new` directly, or from `/tokens` click **Issue your first token** (empty state) or **New token**. This is the same wizard as onboarding, minus the welcome/KYB step.
2. Fill in the token form:
   - **Symbol** — 3–10 uppercase characters.
   - **Display name** — the human-readable name.
   - **Asset class** — what the token represents.
   - **Initial NAV** — entered in `mhUSDC` base units. For example, `1000000` = 1.00 mhUSDC; the form shows this hint.
   - **Minimum investment** — the smallest allowed buy.
   - **Yield schedule** — choose **monthly**, **quarterly**, or **annual**.
3. Review your entries, then click **Deploy issuer stack**.
4. Watch the deploy rail stream its on-chain steps from **pending** to **mined** (~30–60s each).
5. When the success card shows **{SYMBOL} is live**, open the **Arbiscan** link to confirm the deployment.
6. **Activate the token** so investors can buy. Open **HavenBot** (`/agent`) and ask:
   > **"Unpause my &lt;SYMBOL&gt; token"** — e.g. *"Unpause my POLAR token."*

   HavenBot proposes **one** action that **publishes the first NAV** *and* **unpauses** the token; authorize it with your passkey. (You can also do this from the [Tokens dashboard](/guide/issuer/tokens-dashboard).)

::: warning A freshly-deployed token stays PAUSED until you activate it
Deploy stops at "live" with the token **paused and no NAV published yet** — investors can't buy, and the oracle reports it as stale (you may get a "NAV stale" Telegram alert). The **"Unpause my &lt;SYMBOL&gt; token"** command above is what publishes the first NAV and opens it for business. Once that first NAV lands, the platform keeps the NAV fresh automatically — the stale alert won't recur.
:::

::: warning NAV is in base units
**Initial NAV** is base units, not dollars. `1000000` means 1.00 mhUSDC — entering `1` would set a NAV of 0.000001 mhUSDC.
:::

## Expected result

<ExpectedResult>
The success card reads <strong>{SYMBOL} is live</strong> with an <em>Arbiscan</em> link, and the new token appears in your <code>/tokens</code> list.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| **Deploy issuer stack** is disabled | Recheck the form — Symbol must be 3–10 uppercase chars and all required fields filled. |
| Investors can't buy after deploy | Publish the first NAV and **unpause** the token from the [Tokens dashboard](/guide/issuer/tokens-dashboard). |
| A deploy step stalls on **pending** | Each on-chain step takes ~30–60s. See [async waits](/guide/troubleshooting#async-waits). |

→ Next: [Distribute yield](/guide/issuer/distribute-yield)
