---
title: Checkout — URL fragment key
description: Why the AES-256-GCM key lives in the URL fragment and what it protects.
---

::: warning 🚧 In development — not in the Testing Guide
This surface is still being hardened and isn't part of the judge/user [Testing Guide](/guide/). The page below describes the intended design. To evaluate MuHaven today, use [HavenBot](/havenbot/overview) or the [MCP server](/mcp/overview).
:::

# URL fragment key (privacy)

The MuHaven hosted checkout URL splits into two parts:

```
https://muhaven.app/pay/c/01HMTV9X.../#k=AbCdEfGhIjKlMnOpQrStUvWxYz123456
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
              path (server-visible)                fragment (client-only)
```

The **fragment** (everything after `#`) is a base64url-encoded 32-byte AES-256-GCM key. The server stores the **ciphertext** of the session payload; the fragment key decrypts it client-side.

This page explains the security property, what attacks it prevents, and what the limits are.

## The property

> **The MuHaven backend cannot decrypt a checkout session payload, even if it wanted to.**

The session row in `checkout_sessions` stores:

- `id` (the ULID after `/pay/c/`)
- `enc_payload` (AES-256-GCM ciphertext + IV + tag)
- Public metadata (issuer ID, status, created/expires timestamps, webhook URL)

The session row does **not** store the AES-256-GCM key. The key lives only:

1. In the URL fragment (the issuer's browser when they minted it, the buyer's browser when they opened it).
2. In any side-channel where the link was shared (Telegram messages, email, etc.).

## What's in the encrypted payload

Cleartext fields, encrypted at session-create time:

- Token symbol + contract address
- Amount in mhUSDC (6-decimal)
- Issuer label ("Treasury Issuer (Verified)")
- Optional buyer-bound label

What's **not** in the payload (these are public/server-visible):

- The session ID (it's in the path).
- The issuer's user ID (server-side row).
- The expires-at timestamp (server-side row).
- The webhook URL (server-side row; the secret is hashed at rest).
- The status (server-side row, updated on settlement).

The split is intentional: the operator needs visibility into "which sessions are paying webhooks, which have expired, when to cancel old sessions" — but they don't need the cleartext amount or token to do that.

## Why URL fragments specifically?

Three properties of the URL fragment (`#...`) per the HTTP / browser spec:

1. **Fragments are not sent in `Referer` headers.** When the buyer navigates from the checkout page to (say) an Arbiscan link in the success screen, the `Referer` header carries the full URL *up to but not including* the `#`. Arbiscan doesn't learn the key.
2. **Fragments are not logged by web servers.** Apache, Nginx, Cloudflare, your reverse proxy — none of them see the fragment. The server only ever sees the path.
3. **Fragments stay in the address bar.** They're visible to the user, can be copied / shared / forwarded — but they aren't transmitted unless the user explicitly shares the URL.

This isn't a MuHaven invention — it's the Stripe Checkout pattern, the BitWarden share pattern, the standard browser-side capability scheme. We're applying it to a privacy-preserving payment surface.

## Attacks this prevents

### "Operator decides to peek at all payment amounts"

The operator literally cannot. They have ciphertext + IV + tag; without the key, breaking AES-256-GCM is computationally infeasible.

If the operator wanted to learn the amounts, they'd need to:

1. Run a SQL query against `checkout_sessions` → returns only ciphertext.
2. Cross-correlate with on-chain `Subscription.purchase` events at settlement time → learns the **public buyer-wallet ↔ on-chain encrypted-handle** mapping.

The cleartext amount at the moment of purchase is recoverable only if the operator also runs a MITM against the buyer's browser session, which is detectable (TLS pinning + reasonable CSP) and outside the threat model.

### "Operator's DB gets stolen"

The attacker has ciphertext rows. They don't have the keys. They learn:

- Aggregate payment counts.
- Per-issuer payment counts.
- Webhook URLs (not the secrets — those are HMACed at rest).
- Session status.

They don't learn:

- Per-session amounts.
- Per-session token symbols.
- Per-session issuer labels (only the issuer ID, not the human-readable label which is in the payload).

### "Insider screenshots a checkout URL from a logged Telegram message"

The screenshot includes the fragment, so the insider gets the key. They could decrypt the payload and open the checkout page. But:

- They'd then need to pay with their own wallet (the MuHaven wallet that signs is *theirs*, not the original buyer's).
- The audit log would clearly record their wallet as the payer.
- The original issuer notification + webhook would say "buyer 0x[insider] paid", not the intended buyer.

The fragment-key scheme doesn't make checkout URLs "secret" — it makes them **bearer capabilities**. Treat them like passwords: don't paste them into channels you don't trust.

## What the fragment-key scheme doesn't prevent

It's important to be precise. The scheme does **not** prevent:

- **A buyer's browser extension reading the URL.** The buyer's browser sees the fragment. Don't paste your own checkout URL into a browser session with an untrusted extension installed.
- **Sharing the URL to the wrong party.** Like any bearer capability, anyone with the URL can pay. If you accidentally share to a public channel, cancel the checkout immediately.
- **Buyer-side malware.** If the buyer's machine is compromised, the attacker reads the fragment + the buyer's passkey. This is the threat model floor for any browser-based payment.
- **Operator logs the entire `window.location` via injected JS.** The checkout page's CSP locks scripts to `self` precisely to make this hard. If the operator wanted to inject a key-exfil script, they'd have to break their own CSP claims first — which would be detectable via subresource integrity in the page source.

## Sharing checkout URLs safely

✅ **DO:**

- Share via end-to-end encrypted channels (Signal, iMessage, Telegram secret chats, ProtonMail).
- Share as plain text (preserves fragment) over markdown-link surfaces that don't strip fragments.
- Cancel checkouts you didn't share to the intended buyer.

❌ **DON'T:**

- Post in a public channel.
- Email through a corporate proxy that strips fragments (some EAS / Mimecast configs do this).
- Convert to a short URL (most shorteners strip fragments).
- Paste into a "click-track" tool that wraps the URL.

If the buyer reports a "Session not found" error, the most common cause is fragment loss in transit. Re-share the link in a different channel.

## Where next

- [For issuers](/checkout/for-issuers) — how the URL gets minted.
- [For buyers](/checkout/for-buyers) — what the buyer experiences.
- [Webhooks & receipts](/checkout/webhooks) — server-to-server settlement notifications.
