---
title: Sign in with a passkey
description: Create a MuHaven account and sign in with a passkey — no password, no seed phrase.
---

# Sign in with a passkey

<TaskMeta time="~1 min" role="Anyone" needs="a passkey device (Touch ID, Windows Hello, or a security key)" />

> **What you'll do:** Create a MuHaven investor account and sign in using a passkey, then land on the Cash page ready to test.

## Before you begin

::: tip
MuHaven uses passkeys — there is no password and no seed phrase to copy. You just need a device that can create a passkey: Touch ID / Face ID, Windows Hello, or a hardware security key.
:::

## Steps

1. Go to `/login`.
2. If you already have an account, the form is on **Sign In**. To make a new one, use the link at the bottom to switch to **Create account**.
3. Pick the **Investor** role.
4. Give your passkey a name (anything that helps you recognize it later).
5. Click **Create Account** (the button with the Fingerprint icon).
6. Approve with your device when prompted (Touch ID, Windows Hello, or your security key).
7. You land on the **Cash** page. On testnet, click **Enable demo access** to grant yourself the KYC whitelist needed to trade.

## Expected result

<ExpectedResult>
You see the <strong>Welcome to MuHaven</strong> success banner and arrive on the <strong>Cash</strong> page. No password or seed phrase was ever requested.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| "The RP ID is invalid for this domain" or the passkey prompt never appears | See [passkey RP-ID](/guide/troubleshooting#passkey-rp-id). |
| **Buy** / trade actions are blocked after sign-in | You haven't enabled demo access yet — click **Enable demo access** on the Cash page. |

→ Next: [Get test funds](/guide/investor/get-funds)
