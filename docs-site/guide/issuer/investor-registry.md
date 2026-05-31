---
title: Investor registry
description: View the holders of your tokens with compliance data — never per-investor amounts.
---

# Investor registry

<TaskMeta time="~1 min" role="Issuer" needs="Approved issuer" />

> **What you'll do:** Review the holders of your tokens — their identity and compliance status, while their balances stay encrypted.

## Before you begin

::: info Prerequisites
- You're an **approved issuer**.
:::

::: info Issuers never see individual balances
The registry's **balance column always shows "FHE Encrypted"**. There is no decryption here — an issuer never sees any individual investor's balance.
:::

## Steps

1. Go to `/investors`.
2. Read the stats strip: **Total**, **Eligible**, **Ineligible**, and the eligibility rate.
3. Use the **search box** to find a holder by address, or the **KYC-status filter** to narrow the table.
4. Review the holder table: address, KYC status, **whitelisted** (Yes/No), **accredited** (Yes/No), and the **balance** column — always **"FHE Encrypted"**.
5. Click **Load more** to paginate through additional holders.

::: info Scope
The caption scopes the registry to investors holding **your** tokens.
:::

## Expected result

<ExpectedResult>
The table lists holders with their KYC, whitelist, and accreditation status, and every <strong>balance</strong> cell reads <em>"FHE Encrypted"</em> — you get identity and compliance data, never per-investor amounts.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| You expected to see a balance figure | By design, issuers never see per-investor amounts — balances are always FHE Encrypted. |
| Search returns nothing | Confirm you entered a full address; the search matches by address. |
| The list looks incomplete | Click **Load more** to paginate. |

→ Next: [Compliance dashboard](/guide/issuer/compliance)
