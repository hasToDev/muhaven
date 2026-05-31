---
title: Reveal your balance
description: Decrypt your own encrypted balance locally — the core privacy guarantee of MuHaven.
---

# Reveal your balance

<TaskMeta time="instant" role="Investor" needs="a balance (mhUSDC or a holding)" />

> **What you'll do:** Reveal your own encrypted balance locally in your browser — the privacy "aha" of MuHaven.

## Before you begin

::: tip
Your balance is the core privacy guarantee: it is provably yours but publicly unreadable on-chain. Only **you** can reveal it, and revealing happens entirely in your browser — there is no transaction.
:::

## Steps

1. Open any of `/portfolio`, `/trade`, or `/cash`. A glance bar shows your `mhUSDC` balance as a **lock** icon.
2. Click **Reveal** (Eye icon) on the mhUSDC tile or glance bar.
3. The value decrypts **locally in your browser** using a permit — instantly, with no transaction.

## Expected result

<ExpectedResult>
The lock icon is replaced by your plaintext `mhUSDC` value, and the revealed amount now shows across all surfaces (`/portfolio`, `/trade`, `/cash`).
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| The reveal does nothing or errors | See [encrypted balance](/guide/troubleshooting#encrypted-balance). |
| The value still shows a lock elsewhere | Refresh the page — the permit-based decrypt applies per surface on load. |

→ Next: [Sell a position](/guide/investor/sell)
