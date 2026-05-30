---
title: Testing Guide
description: A step-by-step guide for users and judges to exercise every shipped MuHaven feature — investor, AI agent, and issuer.
---

# Testing Guide

This is a hands-on, task-by-task guide for **trying MuHaven yourself** — written for
hackathon judges and first-time users. Every task is one short page: what you'll do,
what you need, the exact steps, and **what success looks like**.

Everything runs on **Arbitrum Sepolia testnet**. No real money, no installs — a browser
and a passkey-capable device (phone, laptop with Touch ID / Windows Hello, or a security
key) is all you need. Gas is sponsored, so you never hold ETH.

::: tip In a hurry? Start with the happy path.
The [**⭐ 10-minute happy path**](/guide/happy-path) walks the single most important
flow end-to-end: sign in → fund → buy an encrypted position → reveal it → ask the agent →
verify on Arbiscan. If you only do one thing, do that.
:::

## How to read this guide

Each task page carries a small strip at the top:

<TaskMeta time="~3 min" role="Investor" needs="Signed in · some mhUSDC" />

…then numbered steps, and a gold **Expected result** block so you know it worked:

<ExpectedResult>
You'll see one of these at the end of every task — if what it describes is on your
screen, the feature passed.
</ExpectedResult>

## Pick a track

<div class="mh-card-grid mh-card-grid--hero">
  <a class="mh-card mh-card--hero" href="/guide/before-you-begin">
    <h3>① Before you begin</h3>
    <p>Two minutes of setup: what you need, how funding works, why gas is free.</p>
  </a>
  <a class="mh-card mh-card--hero" href="/guide/happy-path">
    <h3>⭐ The 10-minute happy path</h3>
    <p>The flagship demo flow, start to finish — the fastest way to see the privacy "aha".</p>
  </a>
</div>

### Investor tasks (I1–I13)

The demand side: fund a wallet, buy and sell encrypted real-world-asset positions,
reveal your own balances, claim yield, transfer, and withdraw.

<div class="mh-card-grid">
  <a class="mh-card" href="/guide/investor/sign-in"><h3>I1 · Sign in</h3><p>Passkey register & login.</p></a>
  <a class="mh-card" href="/guide/investor/get-funds"><h3>I2 · Get funds</h3><p>Testnet USDC from the faucet.</p></a>
  <a class="mh-card" href="/guide/investor/deposit"><h3>I3 · Deposit</h3><p>Convert USDC → mhUSDC.</p></a>
  <a class="mh-card" href="/guide/investor/marketplace"><h3>I4 · Marketplace</h3><p>Browse RWA tokens.</p></a>
  <a class="mh-card" href="/guide/investor/buy"><h3>I5 · Buy</h3><p>Encrypted position + reveal-gate.</p></a>
  <a class="mh-card" href="/guide/investor/reveal-balance"><h3>I6 · Reveal</h3><p>Decrypt your own balance.</p></a>
  <a class="mh-card" href="/guide/investor/sell"><h3>I7 · Sell</h3><p>Instant + queue escalation.</p></a>
  <a class="mh-card" href="/guide/investor/claim-yield"><h3>I8 · Claim yield</h3><p>From a matured epoch.</p></a>
  <a class="mh-card" href="/guide/investor/redemption-queue"><h3>I9 · Queue claim</h3><p>Settle an over-cap sell.</p></a>
  <a class="mh-card" href="/guide/investor/transfer"><h3>I10 · Transfer</h3><p>Encrypted P2P send.</p></a>
  <a class="mh-card" href="/guide/investor/withdraw"><h3>I11 · Withdraw</h3><p>mhUSDC → USDC (async).</p></a>
  <a class="mh-card" href="/guide/investor/activity"><h3>I12 · Activity</h3><p>Verify settlements.</p></a>
  <a class="mh-card" href="/guide/investor/portfolio"><h3>I13 · Portfolio</h3><p>Your dashboard.</p></a>
</div>

### AI agent tasks (A1–A7)

The differentiator: an agent that **reads aggregates, never your raw key**, and — once
you grant a scoped session — executes trades autonomously inside your policy.

<div class="mh-card-grid">
  <a class="mh-card" href="/guide/agent/chat"><h3>A1 · Chat</h3><p>Talk to HavenBot.</p></a>
  <a class="mh-card" href="/guide/agent/reads"><h3>A2 · Reads</h3><p>Portfolio / yields / activity.</p></a>
  <a class="mh-card" href="/guide/agent/set-tier"><h3>A3 · Set tier</h3><p>Advisory → Scoped.</p></a>
  <a class="mh-card" href="/guide/agent/autonomous"><h3>A4 · Autonomous</h3><p>Buy/sell/reinvest/rebalance.</p></a>
  <a class="mh-card" href="/guide/agent/deep-link-confirm"><h3>A5 · Confirm</h3><p>Deep-link passkey approve.</p></a>
  <a class="mh-card" href="/guide/agent/pause"><h3>A6 · Pause</h3><p>The kill-switch.</p></a>
  <a class="mh-card" href="/guide/agent/session-audit"><h3>A7 · Audit</h3><p>Session status + export.</p></a>
</div>

### Issuer tasks (S1–S6)

The supply side, end-to-end: become an issuer, deploy a token, distribute yield, and
read your aggregate-only dashboards.

<div class="mh-card-grid">
  <a class="mh-card" href="/guide/issuer/become-issuer"><h3>S1 · Become issuer</h3><p>KYB auto-approved.</p></a>
  <a class="mh-card" href="/guide/issuer/issue-token"><h3>S2 · Issue a token</h3><p>Deploy + NAV + unpause.</p></a>
  <a class="mh-card" href="/guide/issuer/distribute-yield"><h3>S3 · Distribute yield</h3><p>Prepare → fund epoch.</p></a>
  <a class="mh-card" href="/guide/issuer/tokens-dashboard"><h3>S4 · Tokens</h3><p>Your issued tokens.</p></a>
  <a class="mh-card" href="/guide/issuer/investor-registry"><h3>S5 · Investors</h3><p>Holder registry.</p></a>
  <a class="mh-card" href="/guide/issuer/compliance"><h3>S6 · Compliance</h3><p>Aggregate-only view.</p></a>
</div>

## Help

- [**Reference appendix**](/guide/reference) — app URL, faucet, Arbiscan, contract
  addresses, glossary.
- [**Troubleshooting & FAQ**](/guide/troubleshooting) — the encrypted-balance buy-gate,
  faucet limits, passkey gotchas, async waits.
- [**Not in this guide**](/guide/not-in-this-guide) — features we deliberately left out,
  and why.
