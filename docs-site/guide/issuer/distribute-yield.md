---
title: Distribute yield
description: Run the two-stage prepare-then-fund flow to distribute an encrypted yield epoch.
---

# Distribute yield

<TaskMeta time="~5 min" role="Issuer" needs="Active token with ≥1 investor · mhUSDC (or USDC to auto-wrap)" />

> **What you'll do:** Prepare a yield epoch over your token's holders, then fund it — paying totals only, while per-investor shares stay encrypted.

## Before you begin

::: info Prerequisites
- An **active** token with at least one investor.
- Enough `mhUSDC` to fund the epoch (or USDC — the app auto-wraps if your mhUSDC is short).
:::

::: warning This flow is asynchronous
On-chain phases take **~30–60s each**, and the snapshot is paginated at **50 holders per batch**. Expect to wait between phases — don't refresh expecting instant results.
:::

## Steps

### Stage 1 — Prepare epoch

1. Go to `/distribute` and select a token that has holders.
2. Click **Prepare epoch**. The app runs three on-chain phases in order:
   - **Open** — opens the epoch.
   - **Snapshot** — captures holders, paginated 50 at a time.
   - **Finalize** — finalizes the snapshot on-chain.
3. Wait while the snapshot's total supply is auto-decrypted (~30–60s).

### Stage 2 — Fund epoch

4. Enter the yield **amount** in human-readable `mhUSDC`.
5. Enter the **Outstanding token supply** — or click **Decrypt from chain** to fill it from the finalized epoch.
6. Click **Reveal mhUSDC** to see your available balance. If it's short, the app auto-wraps USDC → mhUSDC for you.
7. Click **Fund · $X** to fund the epoch.

::: tip The flow resumes on refresh
If you reload mid-distribution, `/distribute` restores your in-progress epoch.
:::

## Expected result

<ExpectedResult>
A fund receipt shows the <strong>epoch id</strong>, <strong>total amount</strong>, <strong>holder count</strong>, and <strong>claim-window expiry</strong>, with a fund tx link — and the note <em>"You see totals only · per-investor shares stay encrypted"</em>.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| **Prepare epoch** is disabled | Select a token that actually has holders. |
| **Outstanding token supply** is empty | Click **Decrypt from chain** to pull it from the finalized epoch. |
| Fund seems stuck | Phases take ~30–60s and snapshots batch 50 holders at a time. See [async waits](/guide/troubleshooting#async-waits). |

→ Next: [Tokens dashboard](/guide/issuer/tokens-dashboard) · Investors can now [claim yield](/guide/investor/claim-yield).
