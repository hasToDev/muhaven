---
title: Passkey accounts
description: How your passkey-bound smart account works and what it protects.
---

# Passkey accounts

MuHaven uses **WebAuthn passkeys** as the root of trust for every account. There is no seed phrase, no browser-extension wallet, and no private key on your device. Your **biometric or hardware key** is the only signer.

## What's actually behind your account

Three layers work together:

```
   You ────►  Passkey (WebAuthn credential on device / iCloud / Google PM / hardware key)
                    │
                    ▼
                 MuHaven wallet  (EIP-4337 smart account, ZeroDev-powered)
                    │   ├── First sign-in: passkey dialog → wallet deploy
                    │   ├── Subsequent writes: signed locally by a scoped session key
                    │   └── Session key TTL: default 1 hour (configurable)
                    ▼
              MuHaven contracts (Arbitrum) — encrypted RWA balances
```

**Plain-English summary:** your passkey signs an authorization that installs a short-lived "session key" with a *narrow scope* (only MuHaven functions, only your wallet, only for 1 hour). Day-to-day actions are signed by the session key — fast, no biometric prompt every click — until the hour runs out and you re-authorize.

## Why a passkey instead of a wallet extension

| Concern | Browser extension wallet | MuHaven wallet (passkey) |
|---|---|---|
| Seed phrase to lose | Yes | No |
| Browser-extension supply-chain risk | High (qix incident, 2.6B weekly downloads) | None — no extension |
| Phishing-resistance | Site-name spoofable | WebAuthn RP-ID hard-pinned to `muhaven.app` |
| Cross-device | Manual seed export | Passkey syncs via iCloud / Google PM / 1Password |
| Hardware key support | Some | Yes (any FIDO2 authenticator) |
| Gas paid in ETH | Yes | No — paymaster sponsors gas on Arb Sepolia |
| Recoverability | Seed phrase only | Multiple passkeys per wallet |

## Where your passkey works

Your one MuHaven passkey signs across:

- **HavenBot** in the dashboard (`muhaven.app/agent`).
- **`@muhaven/mcp`** when you complete the device-code authorization (a one-time passkey prompt at `muhaven.app/link?code=...`).
- **OpenClaw / Telegram** for the **mid-tier (Mini-App OTP)** and **high-tier (deep-link passkey)** confirmations.
- **Hosted Checkout** at `muhaven.app/pay/...` — first-time buyers create a passkey at checkout time; returning buyers reuse it.

::: warning RP-ID pinning
Passkeys are *bound to a domain* at the moment they're created. A passkey created on `muhaven.app` cannot be used at `muhaven-link.com` or any other domain — that's the load-bearing phishing-resistance control.

If MuHaven ever migrates domains (we did once: `*.hasto.dev → muhaven.app`, 2026-05-11), existing passkeys do NOT migrate. You'll need to register a new one. Your MuHaven wallet can hold multiple passkeys.
:::

## Sign-in flow

First time:
1. Click **Sign in** on `muhaven.app`.
2. Pick **Create a new passkey**.
3. Approve with Touch ID / Windows Hello / hardware key.
4. Your MuHaven wallet deploys in the background, paymaster-sponsored.

Every time after:
1. Click **Sign in**.
2. Pick your passkey from the OS dialog.
3. You're in — no wallet redeploy.

## Choosing a passkey provider

| Provider | Pros | Cons |
|---|---|---|
| **iCloud Keychain** (Apple) | Syncs across all your Apple devices | Apple-only |
| **Google Password Manager** | Syncs across all your Google sign-in devices | Chrome / Android only |
| **1Password / Bitwarden** | Cross-platform, share with team | Requires the app installed |
| **Hardware key (YubiKey, Solo, Titan)** | Highest assurance; works offline | Single device unless you buy a backup |
| **Platform-only (no sync)** | Fastest setup | Lose the device → lose the key |

> **Recommendation:** for personal use, iCloud Keychain or Google Password Manager are easiest. For higher assurance, a hardware key with a registered backup.

## What happens if you lose a passkey

- If your passkey is synced (iCloud / Google PM / 1Password), it survives the lost device — just sign in on a new device.
- If it's not synced (platform-only or hardware key with no backup), the recovery path depends on whether you registered a backup passkey. Always register at least one backup credential.

::: tip Always register a backup
Register **at least two** passkeys per MuHaven wallet where supported. A second device, a second 1Password vault, a YubiKey kept at home — any of these are good. Your MuHaven wallet supports multiple credentials.
:::

## What MuHaven does NOT know about you

The dashboard backend sees:

- Your wallet address.
- Your role (investor or issuer).
- The aggregate event counts that drive the public metrics page.
- Audit log entries that **you** wrote by taking actions.

It does **not** see:

- Your passkey's private key (it's on your device or in your password manager).
- Your encrypted balances in cleartext (FHE doesn't decrypt server-side).
- Your strategy (the LLM-side context lives in your host, not on our servers — except for HavenBot, where the chat history is server-managed and you can clear it).

See [Privacy boundary](/get-started/privacy-boundary) for the full picture.
