---
title: Checkout — for buyers
description: What the buyer sees when they click a MuHaven pay link.
---

# Hosted Checkout — for buyers

You received a pay link from someone you trust (an issuer, a partner, a friend), and it looks like:

```
https://muhaven.app/pay/c/01HMTV9X.../#k=AbCdEfGhIjKlMnOpQrStUvWxYz123456
```

This is the **MuHaven hosted checkout** surface. Click the link in your browser. Returning buyers complete the flow quickly; first-time buyers create a passkey along the way.

## What you'll see

The `/pay` page loads in your browser. Your browser sends the path (`/pay/c/01HMTV9X.../`) to MuHaven's servers, but **not the fragment** (`#k=...`) — fragments stay client-side by browser spec. The page renders:

```
┌──────────────────────────────────────────────────────┐
│                  🪙 MuHaven                          │
│                                                      │
│  You're paying                                       │
│  ✓ RWA1 Treasury Issuer (Verified)                 │
│                                                      │
│  Amount        500.00 mhUSDC                         │
│  For           500.00 RWA1 (~$501.50 USD)          │
│  Expires       in 23 hours 58 minutes                │
│                                                      │
│  ──────────────────────────────────────────────      │
│                                                      │
│  [Continue]                                          │
└──────────────────────────────────────────────────────┘
```

The cleartext amount and the issuer label come from **decrypting the payload in your browser** with the fragment key. The page's JavaScript:

1. Reads `#k=...` from `window.location.hash`.
2. Fetches the ciphertext from `GET /api/v1/checkout/:sessionId/payload`.
3. Decrypts it locally with AES-256-GCM.
4. Renders.

The server **never** sees the cleartext payload. See [URL fragment key](/checkout/fragment-key).

## Step 1 (first-time buyers) — Create a passkey

If you've never used MuHaven before, the next click takes you through the passkey creation ceremony:

```
┌──────────────────────────────────────────────────────┐
│  Welcome to MuHaven 🪙                               │
│                                                      │
│  To pay, you need a passkey. We'll create one for    │
│  you on this device — no seed phrase, no extension,  │
│  no email signup.                                    │
│                                                      │
│  Your passkey is bound to muhaven.app and lives in   │
│  your device or password manager (iCloud Keychain,   │
│  1Password, Google Password Manager, hardware key).  │
│                                                      │
│  [Create passkey]                                    │
└──────────────────────────────────────────────────────┘
```

Tap **Create passkey**. Your OS shows the WebAuthn dialog (Touch ID / Windows Hello / hardware key). Approve.

Your **MuHaven wallet** (a ZeroDev-powered smart account) deploys in the background, paymaster-sponsored. You now have a MuHaven account — the same one you can use on the dashboard, on Telegram, or via MCP.

## Step 1 (returning buyers) — Sign in

If you already have a MuHaven passkey on this device (or synced via your password manager), the page detects it and shows:

```
[Continue with passkey]
```

Tap it, pick your passkey from the OS dialog, and you're in.

## Step 2 — Fund (if needed)

If your MuHaven wallet's mhUSDC balance is below the checkout amount, the page shows a funding sub-flow:

```
You need 500.00 mhUSDC to complete this purchase.
Current balance: 0.00 mhUSDC

[Get test mhUSDC (faucet)]    [Cancel]
```

On testnet (Arb Sepolia), the **faucet redirect** opens a new tab to the public testnet faucet. Pick the amount, request, come back to the checkout tab — it polls your balance every 5 seconds and auto-advances when funds land.

On production (Arb One), the checkout uses an on-ramp picker — pay with card / Apple Pay / Google Pay and the page polls until funds arrive.

## Step 3 — Confirm the purchase

The page renders the final preview:

```
┌──────────────────────────────────────────────────────┐
│  Confirm purchase                                    │
│                                                      │
│  You're paying        500.00 mhUSDC                  │
│  You'll receive       ~498.50 RWA1 (encrypted)     │
│  NAV                  $1.003                         │
│  Slippage             0.30% max                      │
│                                                      │
│  Signing as           0x1234…cdef                    │
│                                                      │
│  [Cancel]                              [Pay 500]     │
└──────────────────────────────────────────────────────┘
```

Tap **Pay 500**. Your passkey signs the UserOp. The SSE channel streams settlement progress:

- "Signed → submitted to bundler…"
- "Settled in tx 0xdef..."

And the success page renders:

```
┌──────────────────────────────────────────────────────┐
│  ✅ Paid                                             │
│                                                      │
│  500.00 mhUSDC → 498.50 RWA1 (encrypted)           │
│  Tx: 0xdef... [View on Arbiscan]                     │
│                                                      │
│  Your new RWA1 balance is encrypted on-chain.      │
│  To see the cleartext value or claim future yield,   │
│  sign in to https://muhaven.app                      │
│                                                      │
│  [Open my dashboard]                                 │
└──────────────────────────────────────────────────────┘
```

## What you just bought

You hold an encrypted balance of an RWA token. Specifically:

- The on-chain `MuHavenToken._balances[your_address]` is an `euint128` ciphertext.
- Only you (with your MuHaven wallet + decrypt permit) can unseal it.
- The token issuer can distribute yield to all holders; you'll claim your share with `position.claim` when an epoch finalizes.

To inspect your balance: open `muhaven.app`, sign in with the passkey you just created, navigate to **Portfolio**.

## Privacy properties

- **The MuHaven operator did not see the cleartext payload.** They have your wallet address (it's on-chain), the session ID, the issuer label, and the on-chain settlement event. They do **not** have the cleartext amount unless they query the indexer aggregates — which sees only the public ciphertext handle.
- **The buyer's strategy stays private.** Sub-purchases, partial buys, and follow-on actions are individual on-chain transactions; no metadata aggregation by the operator.
- **The passkey RP-ID** is hard-pinned to `muhaven.app`. A phishing link at `muhaven-pay.com` cannot complete the ceremony.

## What if the link is expired or cancelled?

- **Expired** → page shows "This checkout has expired. Ask the issuer for a fresh link."
- **Cancelled** → page shows "This checkout was cancelled by the issuer."
- **Session not found** → either the path is wrong or the fragment key is missing. Check that your link still has the `#k=...` part.

## Returning buyer benefits

Because your MuHaven wallet is the same across MuHaven surfaces, **after one checkout**:

- You can sign in to `muhaven.app` and see your full portfolio.
- You can use HavenBot to claim yield as epochs finalize.
- You can install `@muhaven/mcp` to drive the same account from Claude Code / Desktop / Cursor.
- You can link your Telegram with `@muhaven_bot`.

One passkey, one MuHaven wallet, every surface.

## Where next

- [URL fragment key](/checkout/fragment-key) — the privacy mechanic.
- [For issuers](/checkout/for-issuers) — what the other side looks like.
- [Troubleshooting](/checkout/troubleshooting) — common buyer-side issues.
