---
title: Withdraw to USDC
description: Withdraw confidential mhUSDC back to plaintext USDC through a two-phase async flow.
---

# Withdraw to USDC

<TaskMeta time="~1–3 min" role="Investor" needs="an mhUSDC balance" />

> **What you'll do:** Convert `mhUSDC` back into plaintext USDC, settled from a reserve, through a two-phase async flow.

## Before you begin

::: warning
This withdrawal is a **two-phase async flow** — a necessity of FHE, not a delay you can skip. Phase 1 burns `mhUSDC` and requests a decrypt; Phase 2 settles real USDC from a reserve. It typically takes ~1–3 minutes, occasionally more.
:::

## Steps

1. Go to `/cash` and set the toggle to **Withdraw** (or open `/cash?mode=unwrap`).
2. Enter a USD amount, or use **Max**.
3. Click **Withdraw to USDC**.
4. **Phase 1** burns `mhUSDC` and requests a decrypt, returning a claim.
5. **Phase 2** settles real USDC from the reserve:
   - If the **same browser session** signed the burn, it **auto-claims immediately**.
   - Otherwise, a **Pending USDC claims** list appears. Each claim shows a status badge (**Decrypting** → **Ready to claim**) and a **Claim** button — tap **Claim** once it's ready.

## Expected result

<ExpectedResult>
Your `mhUSDC` is burned and real USDC settles into your wallet — either auto-claimed, or via the <strong>Claim</strong> button in the <strong>Pending USDC claims</strong> list once it's <strong>Ready to claim</strong>.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| A claim sits on **Decrypting** for a while | The decrypt happens off-chain and takes time — see [async waits](/guide/troubleshooting#async-waits). |
| You closed the tab before it claimed | Reopen `/cash` — your claim appears in the **Pending USDC claims** list to finish manually. |

→ Next: [Review your activity](/guide/investor/activity)
