---
title: The 10-minute happy path
description: The flagship MuHaven flow end to end — sign in, fund, buy an encrypted position, reveal it, ask the agent, and verify on-chain.
---

# ⭐ The 10-minute happy path

This is the single flow to run if you're evaluating MuHaven. It takes you from nothing to
a **confidential, on-chain real-world-asset position you can prove exists but no one else
can read** — then shows the agent reading it and the transaction on a public explorer.

<TaskMeta time="~10 min" role="Investor" needs="A browser + a passkey device" />

> **What you'll do:** sign in with a passkey → get testnet USDC → convert it to mhUSDC →
> buy an encrypted position → reveal your own balance → ask HavenBot about it → verify the
> trade on Arbiscan.

::: tip Each step links to its full task page
If a step needs more detail (edge cases, troubleshooting), follow the link in its
heading. Otherwise just keep going down this page.
:::

## 1 · Sign in with a passkey · ~1 min

[Full task → I1](/guide/investor/sign-in)

1. Open [**muhaven.app**](https://muhaven.app) and click **Launch App** — you'll be taken
   to the login page.
2. Use the link at the bottom to switch to **Create account**, pick the **Investor** role,
   name your passkey, and click **Create Account**.
3. Approve with your device (Touch ID / Windows Hello / security key).

::: tip Easiest passkey option on Chrome/Android
When prompted, choose **Google Password Manager** — it saves your passkey to your Google
account and syncs it across devices, so you don't need a hardware key or a specific OS.
It's the smoothest option for testing.
:::

You land on your **Portfolio**. To fund, open **Cash** from the sidebar.

## 2 · Get testnet USDC · ~1–2 min

[Full task → I2](/guide/investor/get-funds)

1. Open the **Cash** page from the sidebar and copy your wallet address with **Copy**.
2. Click **Get test USDC** to open [faucet.circle.com](https://faucet.circle.com/).
3. In the faucet, pick **Arbitrum Sepolia**, paste your address, and click **Send 20 USDC**.
4. Back in MuHaven, your USDC tile lights up with a gold bloom when the funds land
   (usually under a minute).

## 3 · Convert USDC → mhUSDC · ~1 min

[Full task → I3](/guide/investor/deposit)

1. On **Cash**, keep the toggle on **Deposit**.
2. Type an amount (e.g. **100**) or tap a quick-amount chip (**$100 / $1,000 / $5,000**).
3. Click **Convert to mhUSDC** and approve.

Two quick steps run — **Approve USDC**, then **Mint mhUSDC** — and your encrypted mhUSDC
balance appears.

## 4 · Buy an encrypted position · ~2 min

[Full task → I5](/guide/investor/buy)

1. Go to **Trade** (or open a token from **Marketplace** and click its buy CTA, which routes
   you to `/trade`).
2. Choose a token (e.g. **CETES**) and enter a quantity.
3. If your mhUSDC balance shows as locked, click **Reveal mhUSDC to continue** — one tap, no
   transaction. This is the encrypted-balance gate doing its job.
4. Click **Buy CETES** (the CTA reads `Buy <SYMBOL>`) and approve.

::: tip This is the core privacy claim
The exact amount you spend is **encrypted before it ever touches the chain**. The
purchase mints your shares atomically without your cleartext amount appearing on-chain.
:::

## 5 · Reveal your balance — the "aha" · instant

[Full task → I6](/guide/investor/reveal-balance)

1. Open **Portfolio**.
2. Your new holding shows a **lock** icon instead of a number.
3. Click **Decrypt** on the holding card (or **Reveal All** at the top of the Holdings
   section). The number decrypts **locally in your browser** with a permit — no transaction,
   and no one else can do this for your balance.

<ExpectedResult>
Your position is visible to <em>you</em> as a real number, but on-chain it's still an
encrypted handle. That's the whole point: <strong>provably yours, publicly unreadable.</strong>
</ExpectedResult>

## 6 · Ask HavenBot about it · ~1 min

[Full task → H1](/guide/agent/chat)

1. Open **Agent** (the HavenBot chat).
2. Type: *"Summarise my portfolio."*
3. HavenBot reads your aggregates and replies — **without ever holding your key** and
   without seeing your cleartext amounts (it works on encrypted aggregates and the numbers
   you've revealed).

> **Go further:** to let the agent *act* — autonomously reinvest yield or rebalance to
> targets — grant it a Scoped session in [H3 · Set the tier](/guide/agent/set-tier) and
> watch it execute in [H4 · Autonomous execution](/guide/agent/autonomous). Prefer your own
> LLM? Run the same flows over the [MCP track](/guide/mcp/install).

## 7 · Verify on-chain · ~1 min

[Full task → I12](/guide/investor/activity)

1. Open **Activity**.
2. Find your **buy** row and click its **Proof** toggle to expand the privacy-proof panel.
3. Click **View on Arbiscan** to open the transaction on
   [sepolia.arbiscan.io](https://sepolia.arbiscan.io). You'll see the transaction succeeded —
   and that the **amount is not in cleartext** anywhere in the calldata.

<ExpectedResult>
You signed in with a passkey, funded a wallet, and now hold a <strong>confidential RWA
position</strong> — readable by you, opaque to everyone else, and verifiable on a public
block explorer. That's MuHaven.
</ExpectedResult>

## Where to next

- The full [**Investor track**](/guide/investor/sell) — sell, claim yield, transfer, withdraw.
- The [**AI agent track**](/guide/agent/set-tier) — grant autonomy and watch it trade.
- The [**Issuer track**](/guide/issuer/become-issuer) — issue your own token and distribute yield.
- Stuck? [**Troubleshooting & FAQ**](/guide/troubleshooting).
