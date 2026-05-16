---
title: HavenBot — troubleshooting
description: Symptom → fix for the most common HavenBot issues.
---

# HavenBot troubleshooting

A symptom-first reference. If your issue isn't here, check the [`api.muhaven.app/api/v1/public/metrics`](https://api.muhaven.app/api/v1/public/metrics) endpoint for an outage signal first.

## Sign-in & session

### "Sign in succeeded, but the dashboard is empty."

Check the network selector top-right. You may be on a network where your MuHaven wallet doesn't exist (e.g., signed in on Arb Sepolia but viewing Arb One). Switch to the network where your MuHaven wallet was deployed.

### "Passkey dialog doesn't appear."

- Confirm the browser supports WebAuthn (Chrome / Edge / Safari / Firefox — current versions).
- On macOS: System Settings → Passwords → enable iCloud Keychain if you want sync.
- On Windows: Settings → Accounts → Sign-in options → enable Windows Hello.
- If the dialog appears for *other* sites but not MuHaven, your browser may be blocking origin `muhaven.app`. Allow it.

### "I get prompted for my passkey on every action even in Confirm-per-action tier."

Your session key expired. Default TTL is 1 hour. The next action will re-install a fresh session key with one passkey prompt.

If you're seeing the prompt within an hour of installation, the session-key validator may have been uninstalled (e.g., by `/pause`). Resume the agent and the next action will mint a fresh one.

### "I'm signed out unexpectedly."

JWT expiry (silent — happens if your tab sits idle past the refresh window). Sign in again.

## Funding & buying

### "Faucet won't dispense mhUSDC."

Testnet faucets are rate-limited (typically 1 request per address per 24 hours). Wait, or:

- Try a different faucet (the wizard links to one but `https://www.alchemy.com/faucets/arbitrum-sepolia` and friends also work).
- Bridge USDC from Sepolia via the canonical Arb bridge, then wrap.

### "Buy fails with `BalanceTooLow`."

Your mhUSDC balance is below the requested amount. The Subscription contract performs a **silent-fail privacy-preserving** check — the cleartext amount is decreased to zero on a balance shortfall but the UserOp still settles. The audit log records the attempt; no funds move.

To verify your balance, ask HavenBot: "What's my mhUSDC balance?" — the unseal runs in your browser.

### "Buy succeeded but my balance didn't change."

The Arbitrum view-RPC sometimes returns stale data for ~3-5 seconds after a write. Wait, refresh. If it persists past 30 seconds:

- Check Arbiscan for the tx (the toast links to it).
- Verify the tx didn't revert (revert reason in Arbiscan logs).
- If the tx succeeded but your dashboard still doesn't show the balance, file an issue — there may be an indexer lag.

### "ConfirmModal shows `decryptForView` errors."

Your decrypt permit expired. Refresh the page; HavenBot re-mints the permit on next action. If the error persists, try:

1. Sign out, sign back in (forces a fresh permit ceremony).
2. If that fails, check [`api.muhaven.app/health`](https://api.muhaven.app/health) — the CoFHE threshold network may be having a hiccup.

## Chat behavior

### "HavenBot keeps asking me for clarification."

The LLM is set to strict-enum schemas on every tool. If you ask "buy some `<TOKEN>`", HavenBot will ask "how much?" because the `amount` field is required.

Phrase your asks concretely: "Buy 50 mhUSDC of `<TOKEN>`."

### "HavenBot returned an answer in raw JSON."

Rare — usually the LLM stream was interrupted before it could format. Refresh and re-ask.

### "HavenBot says it can't do something I know exists."

Two possibilities:

1. **Tier mismatch.** The tool exists but your tier excludes it (e.g., set_policy → Policy-bound is blocked while you're in Advisory's onboarding window).
2. **Role mismatch.** Issuer tools are hidden from investor passkeys. Sign in with your issuer passkey if you have one — see [Investor vs issuer](/get-started/investor-vs-issuer).

### "Streaming response stops mid-sentence."

Network glitch or LLM timeout. The SSE channel reconnects automatically; if your message isn't completing after 10 seconds, click **Stop** and re-ask.

## ConfirmModal

### "ConfirmModal opened but the preview shows zeros."

The encrypted preview decrypt failed (permit expired, ACL not granted, RPC lag). Cancel and re-ask — HavenBot will re-mint the permit + retry the decrypt.

### "Confirm button is disabled."

- **Insufficient mhUSDC** for a buy. The amount-vs-balance check is client-side. Top up.
- **Tier doesn't allow this action.** The modal's footer explains why (e.g., "Policy-bound caps your daily spend at $500; this would push you to $620").
- **Session key has insufficient remaining allowance.** Pause and resume to mint a fresh key with reset allowances.

### "I clicked Confirm but nothing happened."

Browser pop-up blocker may have suppressed the passkey ceremony (Advisory tier prompts the passkey on every action). Allow popups for `muhaven.app` and retry.

## Issuer flows

### "I see investor tools, but no issuer tools."

You're signed in with your **investor** passkey. Sign out, sign back in with the issuer passkey (different passkey per [one passkey, one role](/get-started/investor-vs-issuer)).

### "Issuer tools are visible but I get 403 NOT_APPROVED_ISSUER on every commit."

Your issuer status isn't `approved` yet. Visit `/apply-issuer` to check; in dev mode it auto-approves but on production it requires manual review.

### "Distribute yield modal shows the wrong investor count."

The investor count is read from `InvestorRegistry` at propose time. If you added KYC entries within the last 30 seconds, the indexer may not have caught up — wait and re-propose.

### "Unpause says my token is already active."

The tool is idempotent. If your token is already unpaused, refuses with `409 ALREADY_ACTIVE` — nothing to do.

## Pause & resume

### "Pause didn't take effect."

The on-chain `uninstallPlugin` UserOp is fast (≤1 Arb block, ~250ms soft) but the backend's reflection of "paused" updates on the next block. Wait 2-3 seconds and check again.

### "Resume failed."

Resume re-installs the session-key validator and signs with your passkey. If the passkey ceremony was cancelled, resume errors with `401 PASSKEY_REQUIRED`. Re-try and complete the passkey prompt.

## Help isn't here?

- Read the surface-level docs ([HavenBot overview](/havenbot/overview)) and [Tool catalog](/reference/tool-catalog).
- Check the [`docs/AGENT_DESIGN.md`](https://github.com/hasToDev/muhaven/blob/master/docs/AGENT_DESIGN.md) in the GitHub repo for the engineering-level reference.
- File an issue at [github.com/hasToDev/muhaven/issues](https://github.com/hasToDev/muhaven/issues).
