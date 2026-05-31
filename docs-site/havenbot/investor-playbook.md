---
title: HavenBot — investor playbook
description: Phrasing that works for buy, claim, rebalance, set policy, pause.
---

# Investor playbook

A working glossary of phrases that HavenBot reliably maps to the right tool. The LLM is good at intent — but a clean phrase saves a round-trip and avoids ambiguity.

Every row below follows the same shape: **what you say** → **what the agent calls** → **what you confirm**. Pick a row, copy the phrase, paste into the agent chat — done.

> Throughout this page, `<TOKEN>` stands in for any active RWA token in your catalog. Replace it with the actual symbol you're working with (the token tile on the dashboard's Tokens page shows the exact spelling).

## Portfolio inspection

These are read-only — no signing, no confirmation.

| You want | Say |
|---|---|
| Current holdings overview | "Show my portfolio." |
| Specific token balance | "What's my `<TOKEN>` balance?" *(triggers `muhaven_unseal_position`)* |
| Yield earned this epoch | "How much did `<TOKEN>` pay last epoch?" |
| Yield earned over a window | "Show `<TOKEN>` yields for the past 30 days." |
| Token NAV | "What's the current NAV of `<TOKEN>`?" |
| Compare token NAVs | "Which active RWA token has the highest NAV right now?" |
| Audit log | "What did my agent do today?" |
| Risk-signal flags | "Am I overexposed?" *(reads `ebool isOverexposed`)* |
| Pending yield across all tokens | "What yield is claimable across all my positions?" |

## Buying

Every buy opens ConfirmModal. The cleartext preview shows amount, estimated shares, NAV, and slippage — you decide whether to sign.

| You want | Say |
|---|---|
| Buy a fixed amount | "Buy 100 mhUSDC of `<TOKEN>`." |
| Buy at a target share count | "Buy ~50 `<TOKEN>` shares." *(HavenBot computes the mhUSDC needed at current NAV)* |
| Quote before buying | "Quote 100 mhUSDC of `<TOKEN>`." |
| Buy a percent of cash | "Put 20% of my mhUSDC into `<TOKEN>`." |
| Buy with a NAV ceiling | "Buy 100 mhUSDC of `<TOKEN>` only if NAV is below 1.005." |

## Claiming yield

| You want | Say |
|---|---|
| Claim a finalized epoch | "Claim my `<TOKEN>` yield for epoch 5." |
| Claim everything available | "Claim all my pending yield." |
| Check what's claimable | "What yield can I claim right now?" |
| Claim and summarize after | "Claim all my pending yield, then show me the new portfolio totals." |

::: tip Yield is per-investor in MuHaven
Each finalized epoch creates a personal `MuHavenEscrow` for every eligible holder. Your claim pulls only your share — the operator never knows your individual amount.
:::

## Set policy / tier

Tier changes are signed by your passkey (not the session key) — see [Tiered autonomy](/policy/tiered-autonomy).

| You want | Say |
|---|---|
| Switch tier | "Switch me to Confirm-per-action." or "Arm Scoped autonomy." |
| Inspect current tier | "What tier am I in?" |
| See my session-key scope | "Show my session-key permissions." |
| Set a per-trade cap (Scoped autonomy) | "Arm Scoped autonomy with a $500 per-trade cap." |
| Set a max drawdown | "Don't let me lose more than 10% in a single position." *(Policy-bound — designed; the risk engine isn't running today)* |
| Re-authorize the session key | "Renew my session key for another hour." |

## The /pause kill-switch

| You want | Say |
|---|---|
| Stop the agent immediately | "Pause my agent." |
| Verify pause status | "Is my agent paused?" |
| Resume | "Resume my agent." |

Pause is **idempotent**: calling it twice doesn't error. It uninstalls the on-chain session-key validator in ≤1 Arb block. Subsequent propose calls return `423 PAUSED`.

Resume mints a fresh session key — your passkey signs the validator-install. See [The /pause kill-switch](/policy/pause).

## Audit & inspection

| You want | Say |
|---|---|
| Recent audit | "Show my agent's audit log." |
| Filter by tool | "Show audit rows for `propose_buy` in the last 7 days." |
| Filter by outcome | "Show only failed agent actions." |
| Filter by surface | "Show audit rows that came from MCP this week." |
| Export | "Export my audit log." *(returns a downloadable JSON)* |

The audit log is your forensic record. See [Audit log](/policy/audit-log) for what's logged vs. what's intentionally not.

## What HavenBot won't do

- **It won't give financial advice.** Ask "should I buy `<TOKEN>`?" and HavenBot will give you the NAV, the recent yield history, the protection-pool state — not "yes, buy it."
- **It won't move funds out of your MuHaven wallet.** The session-key scope is locked to MuHaven contracts. There is no `transfer-to-external-EOA` tool.
- **It won't bypass your tier.** Asking "buy $50K of `<TOKEN>`" while in Advisory tier triggers a passkey prompt; while running under a Scoped autonomy session with a $5K per-trade cap, it's rejected by the on-chain validator (not silently downgraded to $5K).
- **It won't act in another user's account.** Cross-user audit access and encrypted-vote retrieval require permits the other user must sign.

## Common mistakes

- **"Buy `<TOKEN>`"** without an amount → HavenBot will ask you to clarify the amount in mhUSDC or shares.
- **"Sell my `<TOKEN>` position"** while you have zero of that token → the policy gate rejects the propose with `BalanceTooLow` *after* showing you a zero-amount preview (silent-fail privacy property).
- **"Set my risk to high"** → too vague. Use concrete params: "Cap my daily spend at $500", "Allow up to 20% drawdown on `<TOKEN>`".
- **"Pause my MCP and HavenBot but not Telegram"** → `/pause` is **global**. It uninstalls the on-chain validator; there's no per-surface pause. To pause one surface, deauthorize that surface specifically (e.g., `muhaven-broker logout` for MCP).

## Where next

- [Issuer playbook](/havenbot/issuer-playbook) — the issuer-side phrasing.
- [Troubleshooting](/havenbot/troubleshooting) — what to do when things go wrong.
- [Tool catalog](/reference/tool-catalog) — the full schema for every tool.
