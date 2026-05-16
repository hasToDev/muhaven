---
title: HavenBot — investor playbook
description: Phrasing that works for buy, claim, rebalance, set policy, pause.
---

# Investor playbook

A working glossary of phrases that HavenBot reliably maps to the right tool. The LLM is good at intent — but a clean phrase saves a round-trip and avoids ambiguity.

## Portfolio inspection

| You want | Say |
|---|---|
| Current holdings overview | "Show my portfolio." |
| Specific token balance | "What's my TBILL1 balance?" *(triggers `muhaven_unseal_position`)* |
| Yield earned this epoch | "How much did GOLD1 pay last epoch?" |
| Yield earned over a window | "Show GOLD1 yields for the past 30 days." |
| Token NAV | "What's the current NAV of OCEAN?" |
| Audit log | "What did my agent do today?" |
| Risk-signal flags | "Am I overexposed?" *(reads `ebool isOverexposed`)* |

All inspection prompts are read-only — no signing, no confirmation.

## Buying

| You want | Say |
|---|---|
| Buy a fixed amount | "Buy 100 mhUSDC of TBILL1." |
| Buy at a target share count | "Buy ~50 TBILL1 shares." *(HavenBot computes the mhUSDC needed at current NAV)* |
| Quote before buying | "Quote 100 mhUSDC of TBILL1." |
| Buy a percent of cash | "Put 20% of my mhUSDC into GOLD1." |
| Buy across multiple tokens | "Split 200 mhUSDC equally between TBILL1 and GOLD1." *(Wave 5 multicall; today returns 'deferred')* |

Every buy opens ConfirmModal. The cleartext preview shows amount, estimated shares, NAV, and slippage.

## Claiming yield

| You want | Say |
|---|---|
| Claim a finalized epoch | "Claim my TBILL1 yield for epoch 5." |
| Claim everything available | "Claim all my pending yield." |
| Check what's claimable | "What yield can I claim right now?" |

::: tip Yield is per-investor in MuHaven
Each finalized epoch creates a personal `MuHavenEscrow` for every eligible holder. Your claim pulls only your share — the operator never knows your individual amount.
:::

## Rebalancing

::: warning Multi-leg rebalance is Wave 5
HavenBot will plan the rebalance, render the preview, and return `'deferred'` because the multicall ceremony lands in Wave 5. For now, rebalance by issuing two separate prompts:

1. "Sell 50% of my OCEAN position."
2. "Buy 100 mhUSDC of TBILL1."

The audit log records each leg separately.
:::

## Set policy / tier

| You want | Say |
|---|---|
| Switch tier | "Switch me to Confirm-per-action." or "Move me to Policy-bound." |
| Inspect current tier | "What tier am I in?" |
| See my session-key scope | "Show my session-key permissions." |
| Set a daily spend cap | "Cap my daily spend at $500." *(Policy-bound only)* |
| Set a max drawdown | "Don't let me lose more than 10% in a single position." *(Policy-bound only)* |

Tier changes are signed by your passkey (not the session key) — see [Tiered autonomy](/policy/tiered-autonomy).

## The /pause kill-switch

| You want | Say |
|---|---|
| Stop the agent immediately | "Pause my agent." |
| Verify pause status | "Is my agent paused?" |
| Resume | "Resume my agent." |

Pause is **idempotent**: calling it twice doesn't error. It uninstalls the on-chain session-key validator in ≤1 Arb block (~250ms soft). Subsequent propose calls return `423 PAUSED`.

Resume mints a fresh session key — your passkey signs the validator-install. See [The /pause kill-switch](/policy/pause).

## Audit & inspection

| You want | Say |
|---|---|
| Recent audit | "Show my agent's audit log." |
| Filter by tool | "Show audit rows for `propose_buy` in the last 7 days." |
| Filter by outcome | "Show only failed agent actions." |
| Export | "Export my audit log." *(returns a downloadable JSON)* |

The audit log is your forensic record. See [Audit log](/policy/audit-log) for what's logged vs. what's intentionally not.

## What HavenBot won't do

- **It won't give financial advice.** Ask "should I buy TBILL1?" and HavenBot will give you the NAV, the recent yield history, the protection-pool state — not "yes, buy it."
- **It won't move funds out of your kernel.** The session-key scope is locked to MuHaven contracts. There is no `transfer-to-external-EOA` tool.
- **It won't bypass your tier.** Asking "buy $50K of TBILL1" while in Advisory tier triggers a passkey prompt; while in Policy-bound tier with a $5K cap, it's rejected by the gate (not silently downgraded to $5K).
- **It won't act in another user's account.** Cross-user audit access and encrypted-vote retrieval require permits the other user must sign.

## Common mistakes

- **"Buy TBILL1"** without an amount → HavenBot will ask you to clarify the amount in mhUSDC or shares.
- **"Sell my GOLD1 position"** while you have zero GOLD1 → the policy gate rejects the propose with `BalanceTooLow` *after* showing you a zero-amount preview (silent-fail privacy property).
- **"Set my risk to high"** → too vague. Use concrete params: "Cap my daily spend at $500", "Allow up to 20% drawdown on OCEAN".
- **"Pause my MCP and HavenBot but not Telegram"** → `/pause` is **global**. It uninstalls the on-chain validator; there's no per-surface pause. To pause one surface, deauthorize that surface specifically (e.g., `muhaven-broker logout` for MCP).

## Where next

- [Issuer playbook](/havenbot/issuer-playbook) — the issuer-side phrasing.
- [Troubleshooting](/havenbot/troubleshooting) — what to do when things go wrong.
- [Tool catalog](/reference/tool-catalog) — the full schema for every tool.
