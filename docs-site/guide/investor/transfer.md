---
title: Transfer to a peer
description: Send encrypted RWA shares peer-to-peer, with live recipient KYC validation.
---

# Transfer to a peer

<TaskMeta time="~1 min" role="Investor" needs="a holding + a recipient address" />

> **What you'll do:** Send whole shares of an RWA token to another address as a confidential, peer-to-peer transfer.

## Before you begin

::: tip
On testnet, **dev-mode** bypasses recipient KYC, so you can transfer to any address. The form still shows a live KYC status so you can see how it behaves.
:::

## Steps

1. Go to `/transfer` and pick a token.
2. Paste a recipient address into the field (placeholder `0x…`).
3. Enter the number of shares — **whole shares** only.
4. Check the live recipient validation:
   - **Recipient is KYC-verified** (green)
   - **Recipient is not KYC-verified — transfer would revert with RecipientNotKYC** (red)
   - **Dev-mode active — KYC bypassed (recipient is NOT actually verified)** (yellow — the testnet default)
5. Click **Encrypt & Send**.

## Expected result

<ExpectedResult>
You see the <strong>"Transfer sent"</strong> card. The recipient's new balance is encrypted to them, and you'll see a transfer-out in your Activity feed (a transfer-in in theirs).
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| The amount field rejects your value | Transfers must be **whole shares** (integers). |
| Recipient shows red **not KYC-verified** | On a live network that transfer would revert; on testnet, dev-mode should show yellow instead. |
| You want to confirm it landed | Check [Activity](/guide/investor/activity) for the transfer-out / transfer-in rows. |

→ Next: [Withdraw to USDC](/guide/investor/withdraw)
