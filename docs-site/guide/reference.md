---
title: Reference appendix
description: App URLs, faucet links, Arbiscan, deployed contract addresses, and a glossary for the MuHaven Testing Guide.
---

# Reference appendix

Everything you might need to look up while testing.

## App URLs

| What | URL |
|---|---|
| **Dashboard (production)** | [muhaven.app](https://muhaven.app) |
| Sign in | [muhaven.app/login](https://muhaven.app/login) |
| HavenBot chat | [muhaven.app/agent](https://muhaven.app/agent) |
| **Documentation** | [docs.muhaven.app](https://docs.muhaven.app) |

::: tip Always register your passkey on the domain you'll test on.
A passkey created on one domain won't work on another. For the public app, register on
[muhaven.app](https://muhaven.app). See [Troubleshooting](/guide/troubleshooting#passkey-rp-id).
:::

## Network

| | |
|---|---|
| **Chain** | Arbitrum Sepolia (testnet) |
| **Chain ID** | `421614` |
| **Block explorer** | [sepolia.arbiscan.io](https://sepolia.arbiscan.io) |
| **Gas** | Sponsored — you never need ETH |

## Faucets (get testnet funds)

| Token | Where | Notes |
|---|---|---|
| **USDC** | [faucet.circle.com](https://faucet.circle.com/) | Select **Arbitrum Sepolia**. This is the only token you need. |
| ETH / gas | *Not needed* | MuHaven sponsors gas via a paymaster. |

::: warning Faucet rate limits are the most common stall.
Circle's faucet drips a fixed amount per address per time window. If it refuses you,
either wait the cooldown or fund a second address. You only need a small amount (e.g.
$100 of test USDC) to exercise the whole guide. See
[Troubleshooting → Faucet](/guide/troubleshooting#faucet-limits).
:::

## Is there a pre-funded demo account?

**No shared login.** MuHaven authenticates with **passkeys**, which are bound to your
physical device and can't be handed out. Every tester creates their own account in under a
minute ([I1](/guide/investor/sign-in)) and funds it from the faucet ([I2](/guide/investor/get-funds)).
This is by design — it's a live platform with no shared credentials.

## Deployed contracts (Arbitrum Sepolia)

These are public on-chain addresses — open any of them on
[sepolia.arbiscan.io](https://sepolia.arbiscan.io). All MuHaven contracts are upgradeable
proxies.

### Platform singletons

| Contract | Address | Role |
|---|---|---|
| **MuHavenStable (mhUSDC)** | `0xF9bc25b67238C870255c33EC75fA37A09C00edE7` | Confidential USDC wrapper; the currency for buys & yield |
| **MuHavenSubscription** | `0x39D49B2614d24ba189B613bEAa903d829A73eA9e` | Atomic buy / redeem coordinator |
| **TokenRegistry** | `0x4915E9Aa034244e299fb1609792D66b9fFAbf885` | Per-token configuration registry |
| **InvestorRegistry** | `0xE7D4CB42EdB19e268e5e8a10d1A02f321Bfa50D0` | Holder enumeration (drives yield) |
| **YieldSnapshot** | `0xaC4163f84db2C85333D5aF6f87848d7362A59887` | Pull-based yield distribution |
| **IssuerControlledOracle** | `0xD30069114dFC83C714B04d6036dEfa64d2E9d583` | NAV oracle (issuer-written) |

### External token

| Token | Address |
|---|---|
| **USDC (Circle, Arb Sepolia)** | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` |

### Example RWA token (CETES)

| Contract | Address |
|---|---|
| **MuHavenToken (CETES)** | `0xF3945c52DB79eBc6BFEA1dc460Ead77D70858B43` |
| MuHavenTreasury (CETES) | `0xEd596e61A22f3099a21dFD2C07BEEDbcbd3a7c74` |
| RedemptionQueue (CETES) | `0x3f8D8350EEE036f6FbEA64B68886cEd11cF28ddC` |

::: info The marketplace lists many more tokens.
CETES is one example. The live [marketplace](/guide/investor/marketplace) carries a
rotating set of tokenized treasuries, gold, money-market funds, and tokenized equities.
Each token's detail page links its on-chain address.
:::

## Glossary

| Term | Meaning |
|---|---|
| **mhUSDC** | MuHaven's confidential USDC wrapper (contract: *MuHavenStable*). Encrypted balance; the settlement currency for every flow. Always written `mhUSDC`. |
| **fhERC-20** | An encrypted ERC-20: balances are ciphertext (`euint128`) on-chain. MuHaven's RWA tokens are fhERC-20. |
| **FHE / CoFHE** | Fully Homomorphic Encryption. MuHaven uses **Fhenix CoFHE** — a coprocessor on Arbitrum that computes on encrypted values and decrypts asynchronously. |
| **Passkey** | A device-bound WebAuthn credential (Touch ID, Windows Hello, security key). Your login and your signer — there's no password or seed phrase. |
| **Kernel / ZeroDev** | Your smart account (ERC-4337) created by ZeroDev and controlled by your passkey. Enables sponsored gas and scoped session keys. |
| **Scoped session key** | A short-lived, narrowly-permissioned key you grant the agent so it can execute *within your policy* without holding your passkey. |
| **How the agent acts** | Either it proposes and you approve each action with your passkey (a dashboard deep-link), or — with a Scoped session you granted — it executes autonomously within your per-trade cap. |
| **NAV** | Net Asset Value per share, set by the issuer's oracle. A buy reverts if the NAV is stale. |
| **Redemption queue** | When an instant sell exceeds the per-epoch instant cap, the overflow is queued and settles in a later epoch. |
| **KYC / ERC-3643** | The compliance whitelist. On testnet, a dev-mode bypass lets you transfer freely. |
| **Epoch** | One yield-distribution round for a token. Investors claim their share from a settled epoch. |

→ Need to fix something? [**Troubleshooting & FAQ**](/guide/troubleshooting)
