---
title: Become an issuer
description: Register an Issuer account, open the Apply wizard, get auto-approved (testnet), and deploy your on-chain issuer stack.
---

# Become an issuer

<TaskMeta time="~3–5 min" role="Issuer" needs="An Issuer-role passkey account" />

> **What you'll do:** sign in as an issuer, open the **Apply** wizard, get auto-approved (testnet), and deploy your full on-chain issuer stack.

## Before you begin

::: info You need an Issuer-role account
Your role — **Investor** or **Issuer** — is chosen **when you create the account** and is fixed per passkey. An Investor passkey **can't** apply to become an issuer: there's no in-app role switch. If you only have an Investor account, **create a new account and pick the Issuer role** (Step 1 below). Gas is sponsored, so you don't need any ETH.
:::

::: tip Already an approved issuer?
Signing in lands you on `/tokens`, and the **Apply** item disappears from the sidebar — skip to [Issue a token](/guide/issuer/issue-token).
:::

## Steps

1. **Create (or sign in with) an Issuer account.** Open [muhaven.app](https://muhaven.app) → **Launch App**. On the login card, use the link at the bottom to switch to **Create account**, choose the **Issuer** role, name your passkey, and click **Create Account** — then approve with your device. (See [I1 · Sign in](/guide/investor/sign-in) for the passkey details.)
   ::: tip Wrong-role sign-in
   If you try to sign in as the wrong role, MuHaven tells you *"This passkey is registered as an Investor / an Issuer"* and flips the selector for you — pick the matching role and sign in again.
   :::
2. **Open the Apply wizard.** A brand-new issuer account lands on it automatically. Anytime before you're approved, you can also click the pulsing **Apply** item at the top of the sidebar (desktop) or top bar (mobile) — it only shows for unapproved issuers. (Direct URL: `/apply-issuer`.)
3. On **Step 1 — Welcome + KYB**, enter your **Legal entity name**, **jurisdiction**, and **contact email**, then click **Submit application**.
   ::: tip Testnet KYB is auto-approved
   On testnet your KYB application is **auto-approved the moment you submit** — there's no waiting on a reviewer.
   :::
4. Click **Next** through the token-basics and economics steps. These collect your token's details — they're covered in full in [Issue a token](/guide/issuer/issue-token).
5. On the review step, click **Deploy issuer stack** to start deployment.
6. Watch the live deploy rail. It streams ~10 on-chain steps — deploy token, deploy redemption queue, deploy treasury, deploy yield snapshot, wire pointers, authorize registries, configure oracle, and register the token — each moving from **pending** to **mined** (~30–60s each).
7. When the success card appears, follow its final prompt to publish your first NAV and unpause the token, via HavenBot or the [Tokens dashboard](/guide/issuer/tokens-dashboard).

::: tip The wizard resumes on refresh
If you reload mid-flow, the wizard picks up where you left off — your progress isn't lost.
:::

## Expected result

<ExpectedResult>
You see the <strong>Issuer stack deployed</strong> success card with an <em>Arbiscan</em> link to the deployed token.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| There's no **Apply** item in the sidebar | You're signed in as an **Investor**. The role is fixed per passkey — create a new account and pick the **Issuer** role (Step 1). |
| Sign-in says the passkey is the wrong role | Expected — MuHaven flips the role selector to the registered role; pick it and sign in again. |
| `/apply-issuer` redirects you to `/tokens` | You're already an approved issuer — go straight to [Issue a token](/guide/issuer/issue-token). |
| A deploy step sits on **pending** | On-chain steps take ~30–60s each; give it time. See [async waits](/guide/troubleshooting#async-waits). |
| You refreshed and lost your place | The wizard resumes automatically — reopen `/apply-issuer`. |

→ Next: [Issue a token](/guide/issuer/issue-token)
