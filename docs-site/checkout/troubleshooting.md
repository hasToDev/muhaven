---
title: Checkout — troubleshooting
description: Symptom → fix for the most common hosted-checkout issues.
---

# Hosted Checkout troubleshooting

## Issuer side

### "HavenBot won't show me the create-checkout tool"

Three checks:

1. **You're signed in as an issuer.** Investor passkeys don't see this tool.
2. **Your issuer status is `approved`.** Pending / suspended → 403 NOT_APPROVED_ISSUER.
3. **You're on the right network.** Some testnet deploys don't have the checkout backend wired; check `/health` on `api.muhaven.app`.

### "Created the link, shared it, buyer says 'Session not found'"

The fragment got stripped in transit. Common channels that strip fragments:

- Some markdown renderers (Slack message link auto-cards on certain workspace settings).
- URL shorteners (bit.ly, t.co, etc.).
- Click-track wrappers (HubSpot, Marketo, etc.).
- Corporate email gateways with link-rewriting (Microsoft Safe Links, Mimecast).

Re-share as **plain text** (preserves the `#k=...` part) over a non-rewriting channel (Signal, plain SMS, direct DM).

### "Webhook isn't firing"

In order:

1. **Verify the URL is reachable** from MuHaven's egress IP. `curl -I` from your laptop isn't enough — your endpoint may have IP-allowlist gates that don't include MuHaven's IPs.
2. **Check that the URL passed the SSRF guard.** If `create_checkout` returned `400 INVALID_WEBHOOK_URL`, your URL is on the deny-list (RFC1918 / loopback / link-local). Use a public HTTPS URL.
3. **Check your endpoint isn't returning 5xx.** MuHaven retries 5 times with backoff, then marks the webhook as `failed`. The audit log entry tells you which delivery attempt failed.
4. **Check `MuHaven-Signature` verification on your side.** If you're returning 4xx because the signature check fails, MuHaven treats it as success-from-you and stops retrying. Make sure you verify on the **raw body bytes**, not the JSON-parsed string.

### "Webhook fired but with stale data"

The retry mechanism uses the **same** event payload — if you got an out-of-order delivery (T+30s retry arrives before T+0s original due to network jitter), the `Idempotency-Key` lets you dedupe.

### "I want to cancel a session but it says `already paid`"

Sessions become immutable once they hit a terminal state (`paid` / `expired` / `cancelled`). You can't un-cancel or re-mint a paid session — mint a new checkout if you need to invoice again.

### "The webhook payload is missing fields I expected"

Webhook payloads are intentionally minimal. If you need additional fields (e.g., buyer's encrypted balance handle), the design choice was: webhook = bare facts; full enrichment via the dashboard / HavenBot. File an issue if you need a specific field.

## Buyer side

### "I clicked the link but the page is blank / shows 'Session not found'"

Three possibilities:

1. **The URL fragment was stripped.** Ask the issuer to re-share — the `#k=...` part must be present.
2. **The session expired.** Check the URL for an obviously old timestamp; ask for a fresh one.
3. **The session was cancelled.** Ask the issuer to re-mint.

### "Passkey creation dialog doesn't appear"

- Confirm your browser supports WebAuthn (Chrome / Edge / Safari / Firefox, current versions).
- On macOS: enable iCloud Keychain (System Settings → Passwords).
- On Windows: enable Windows Hello (Settings → Accounts → Sign-in options).
- Some incognito / private modes disable WebAuthn — open in a normal window.

### "Created passkey, but checkout says 'Insufficient mhUSDC'"

You need mhUSDC to complete the purchase.

- **On testnet:** click the **Faucet** button; receive 100 mhUSDC; come back.
- **On production:** use the on-ramp picker shown at checkout (pay with card / Apple Pay / Google Pay).

### "Funding succeeded but checkout still says 'Waiting for funds'"

The polling interval is 5 seconds; balance updates register shortly after funds land. If it persists:

1. Verify the funds landed in your **MuHaven wallet address** (not your EOA). The checkout shows your MuHaven wallet address; the faucet may have funded a different address by accident.
2. Refresh the page; on reload, the buy ceremony re-checks balance.

### "Confirm button signed but the page is stuck on 'Settling…'"

The settlement waits for an on-chain event. Three checks:

1. **Tx submitted?** Open Arbiscan with your MuHaven wallet address; if the buy UserOp is there, settlement is on-chain.
2. **SSE channel disconnected?** Refresh. The page re-subscribes.
3. **Indexer lag?** The indexer can have occasional lag spikes. Wait. If still stuck, the buy still settled — open the dashboard at `muhaven.app/portfolio` to see the encrypted balance.

### "Got 'Settled' but the issuer says they didn't receive a webhook"

The webhook may have failed (the issuer's endpoint was down). The buy settled on-chain regardless; the issuer can verify via:

- Their HavenBot's SSE notification.
- The dashboard `checkout_sessions` row showing `status: paid`.
- The on-chain `Subscription.Purchase` event with your MuHaven wallet + the session ID in metadata.

This is a "webhook delivery is best-effort" property — on-chain settlement is the source of truth.

## Multi-buyer

### "Can two buyers redeem the same link?"

No — sessions are single-use. The first successful settlement marks `status: paid` and subsequent attempts return `409 ALREADY_PAID`.

If you need a multi-buyer link, mint a separate session per buyer.

### "I'm a returning buyer using my existing MuHaven wallet — why does the page ask me to create a passkey?"

Two possibilities:

1. **You're on a different device** without your synced passkey. Your iCloud Keychain / Google Password Manager hasn't synced this device yet; let it catch up and refresh.
2. **You created your MuHaven wallet on a different domain.** If you originally signed up on `*.hasto.dev` (pre-2026-05-11 migration), your passkey doesn't migrate to `muhaven.app`. Create a new one; the new MuHaven wallet will have its own audit log starting from this purchase.

## Where next

- [For issuers](/checkout/for-issuers) — full create-link walkthrough.
- [For buyers](/checkout/for-buyers) — the buyer-side flow.
- [Webhooks & receipts](/checkout/webhooks) — verifier code and retry semantics.
- [URL fragment key](/checkout/fragment-key) — the privacy mechanic.
