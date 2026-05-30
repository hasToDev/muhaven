---
title: Buy an RWA position
description: Buy an encrypted RWA position, using the one-tap reveal-gate when your mhUSDC balance is encrypted.
---

# Buy an RWA position

<TaskMeta time="~2 min" role="Investor" needs="KYC (demo access) + enough mhUSDC" />

> **What you'll do:** Buy a real-world-asset token with confidential `mhUSDC`, learning how the reveal-gate works along the way.

## Before you begin

::: important
Because `mhUSDC` is encrypted, MuHaven can't read your balance to decide if you can afford a buy. That's why there's a **reveal-gate**: you reveal your own balance locally (no transaction) so the app can enable the **Buy** button. The reveal is a one-tap local decrypt — it never leaks anything on-chain.
:::

## Steps

1. Go to `/trade`. Keep the toggle on **Buy** (the toggle is **Buy | Sell**).
2. Choose a token and enter a quantity, or tap a quick chip: **100 / 1,000 / 5,000**. The NAV is shown in plaintext.
3. **The reveal-gate:** if your `mhUSDC` balance is unknown, the **Buy** button is disabled and you'll see an inline **Reveal mhUSDC balance** button (Eye icon) with a note that your balance is encrypted. Tap it — this is a one-tap local decrypt with **no transaction** and no on-chain leak.
4. After revealing:
   - If you have enough, **Buy** enables.
   - If you're short, you'll see a **Short $X** hint and a **Top up cash** link to `/cash`.
5. Click **Buy {SYMBOL}** (for example **Buy TBILL1**). The label changes to **Purchasing TBILL1…**. Internally the app runs **Encrypt** (client-side) then **Purchase** (on-chain).
6. On your first buy, you'll also approve a one-time `mhUSDC` allowance for the Subscription contract.

## Expected result

<ExpectedResult>
You see the <strong>"Purchase confirmed"</strong> card with an Arbiscan transaction link and a <strong>Make another purchase</strong> button. The exact spend amount was encrypted before it ever hit the chain.
</ExpectedResult>

## If something goes wrong

| Symptom | Fix |
|---|---|
| **Buy** stays disabled even though you have funds | You haven't revealed your balance yet — tap **Reveal mhUSDC balance**. See [the buy-gate](/guide/troubleshooting#buy-gate). |
| You see **Short $X** | You don't have enough `mhUSDC` — use **Top up cash** to add more on `/cash`. |
| Trade actions are blocked entirely | You may not be KYC-verified — enable demo access first (see [Sign in](/guide/investor/sign-in)). |

→ Next: [Reveal your balance](/guide/investor/reveal-balance)
