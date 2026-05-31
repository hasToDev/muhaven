---
title: Sign in with a passkey
description: Create a MuHaven account and sign in with a passkey — no password, no seed phrase.
---

# Sign in with a passkey

<TaskMeta time="~1 min" role="Anyone" needs="a passkey device (Touch ID, Windows Hello, or a security key)" />

> **What you'll do:** Create a MuHaven investor account and sign in using a passkey, then land on your Portfolio ready to test.

## Before you begin

::: tip
MuHaven uses passkeys — there is no password and no seed phrase to copy. You just need a device that can create a passkey: Touch ID / Face ID, Windows Hello, or a hardware security key.
:::

::: tip Easiest passkey option on Chrome/Android
When your device prompts you to save the passkey, choose **Google Password Manager** — it stores the passkey in your Google account and syncs it across devices, so you don't need a hardware key or a specific OS. It's the smoothest option for testing.
:::

## Steps

1. Open [**muhaven.app**](https://muhaven.app) and click **Launch App** — you'll be taken to the login page.
2. If you already have an account, the form is on **Sign In**. To make a new one, use the link at the bottom to switch to **Create account**.
3. Pick the **Investor** role.
4. Give your passkey a name (anything that helps you recognize it later).
5. Click **Create Account** (the button with the Fingerprint icon).
6. Approve with your device when prompted (Touch ID, Windows Hello, or your security key).
7. You land on your **Portfolio**. On testnet, KYC is auto-bypassed, so there's no extra access step — you can fund and trade right away. To add testnet funds, open **Cash** from the sidebar.

## Expected result

<ExpectedResult>
You see the <strong>Welcome to MuHaven</strong> success state and arrive on your <strong>Portfolio</strong>. No password or seed phrase was ever requested, and no KYC step is needed to trade on testnet.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| "The RP ID is invalid for this domain" or the passkey prompt never appears | See [passkey RP-ID](/guide/troubleshooting#passkey-rp-id). |
| The passkey prompt offers several save locations | On Chrome/Android pick **Google Password Manager** for the simplest cross-device experience. |

→ Next: [Get test funds](/guide/investor/get-funds)
