---
title: Become an issuer
description: Apply for issuer access and deploy your on-chain issuer stack in one wizard.
---

# Become an issuer

<TaskMeta time="~3–5 min" role="Issuer" needs="Signed in (any account)" />

> **What you'll do:** Apply for issuer access, get auto-approved (testnet), and deploy your full on-chain issuer stack.

## Before you begin

::: info Prerequisites
- You're signed in. You can apply from **any** account — no special role is required up front.
- Gas is sponsored, so you don't need any ETH.
:::

::: tip Already an issuer?
If your account is already an approved issuer, `/apply-issuer` redirects you straight to `/tokens`.
:::

## Steps

1. Go to `/apply-issuer` to open the multi-step wizard.
2. On **Step 1 — Welcome + KYB**, enter your **display name**, **jurisdiction**, and **contact email**, then click **Submit application**.
   ::: important Testnet KYB is auto-approved
   On testnet your KYB application is **auto-approved the moment you submit** — there's no waiting on a reviewer.
   :::
3. Click **Next** through the token-basics and economics steps. These collect your token's details — they're covered in full in [Issue a token](/guide/issuer/issue-token).
4. On the review step, click **Deploy issuer stack** to start deployment.
5. Watch the live deploy rail. It streams ~10 on-chain steps — deploy token, deploy redemption queue, deploy treasury, deploy yield snapshot, wire pointers, authorize registries, configure oracle, and register the token — each moving from **pending** to **mined** (~30–60s each).
6. When the success card appears, follow its final prompt to publish your first NAV and unpause the token, via HavenBot or the [Tokens dashboard](/guide/issuer/tokens-dashboard).

::: tip The wizard resumes on refresh
If you reload mid-flow, the wizard picks up where you left off — your progress isn't lost.
:::

## Expected result

<ExpectedResult>
You see the <strong>Issuer stack deployed</strong> card reading <strong>{SYMBOL} is live</strong>, with an <em>Arbiscan</em> link to the deployed token.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| `/apply-issuer` redirects you to `/tokens` | You're already an approved issuer — go straight to [Issue a token](/guide/issuer/issue-token). |
| A deploy step sits on **pending** | On-chain steps take ~30–60s each; give it time. See [async waits](/guide/troubleshooting#async-waits). |
| You refreshed and lost your place | The wizard resumes automatically — reopen `/apply-issuer`. |

→ Next: [Issue a token](/guide/issuer/issue-token)
