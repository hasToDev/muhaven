---
title: OpenClaw — troubleshooting
description: Symptom → fix for skill install and Telegram bot issues.
---

# OpenClaw + Telegram troubleshooting

## Skill install

### "ClawHub install succeeded but the skill won't start"

Most common cause: `npm install --omit=dev` wasn't run in the skill directory. Run it manually:

```bash
cd ~/.openclaw/skills/muhaven-rwa-skill
npm install --omit=dev
```

### "muhaven-broker not found"

The skill's `mcp.bundled` binary is `@muhaven/mcp`, which the ClawHub install pulls from npm. But the **broker bin** (`muhaven-broker`) needs to be globally installed and on `$PATH`:

```bash
npm install -g @muhaven/mcp@0.1.3
```

This is documented in the skill's `config.json#post_install_review.items` (`broker-bin-on-path`).

### "Sigstore signature verification failed"

The ClawHub install verifies the skill against the GitHub OIDC issuer `hasToDev/muhaven`. If verification fails:

1. Confirm you're installing from ClawHub (not a tarball from a random source).
2. Run `clawhub --version` — older clawhub versions had buggy Sigstore verification; update to `clawhub@0.12.3` or later.
3. If you're on a fork of the repo, the OIDC issuer won't match — use the upstream skill, not the fork.

### "Subset filter says 'empty registry'"

The `@muhaven/mcp` version bundled with the skill doesn't match the version the subset filter expects. The skill enforces a triple-match (`SKILL.md` frontmatter ↔ `manifest.json#mcp.bundled_version` ↔ `package.json#version` of the installed bundled package).

Fix: install the exact bundled version:

```bash
npm install -g @muhaven/mcp@$(grep bundled_version ~/.openclaw/skills/muhaven-rwa-skill/manifest.json | head -1 | awk -F'"' '{print $4}')
```

Or update the skill: `clawhub install muhaven-rwa-skill@latest`.

## Telegram bot

### "/link reports `expired code`"

Link codes are TTL 5 minutes. If you took longer than that to paste it into the dashboard, request a new one:

```
/link
```

### "/buy says `not linked`"

You haven't completed the `/link` ceremony, or you unlinked. Re-run `/link` and paste the code into the dashboard.

### "Inline button does nothing when tapped"

Three likely causes:

1. **Tap is from a different Telegram user.** The bot enforces `from.id === chat.id && chat.type === 'private'`. Group-chat taps are refused.
2. **Intent expired.** The 5-min TTL ran out between `/buy` and your tap.
3. **Bot service-secret is misconfigured.** This is an operator issue; report it.

### "Mini App opens but says `intent not found`"

The intent expired (5-min TTL) or the URL fragment is malformed. Re-issue the buy:

```
/buy 1000 RWA1
```

### "Mini App OTP says `invalid`"

OTPs are single-use, 6 digits, expire in 5 minutes:

- Wrong code → re-check the OTP in your password manager (or wherever it was delivered).
- Expired → re-issue the buy.
- Already used → the intent already settled; check `/audit` for confirmation.

### "Passkey deeplink opens but the page is blank"

Two possibilities:

1. **The dashboard is unreachable.** Check `https://api.muhaven.app/health`.
2. **The intent doesn't belong to your MuHaven wallet.** The dashboard validates that the intent's `userId` matches the JWT's `userId`; mismatch returns 404.

### "Bot replies `423 PAUSED` on every command"

Your agent is paused. Either:

```
/pause           # idempotent — no-op if already paused
```

doesn't unpause. To resume, sign in to the dashboard at `muhaven.app/agent` and complete the resume ceremony (passkey signature).

The bot can pause but cannot resume — resume requires a WebAuthn ceremony that needs a browser.

## Three-tier classifier

### "Buy with amount $200.01 went to Mini-App OTP, not Inline"

That's expected — the inline ceiling is **≤ $200 inclusive**, and $200.01 > $200. The boundaries are hard-coded; investors cannot raise them.

### "I want all my buys to go through the dashboard passkey"

There's no per-user override for the classifier today. The closest equivalent: set your tier to `Advisory` on the dashboard, which makes every `position.*` proposal prompt your passkey regardless of source surface. Telegram inline taps will still be rejected at the policy gate.

### "I want sub-$200 buys to require Mini-App OTP for extra friction"

Not supported today. The classifier is one-way — raising friction within a tier isn't a per-user knob.

## Subset & manifest

### "Skill bundled wrong version of @muhaven/mcp"

The verify-subset gate enforces the triple-match at the skill's build time. If you see a runtime mismatch (e.g., bundled version is `0.1.0` but `@muhaven/mcp` globally installed is `0.1.2`):

```bash
# Update both to the latest skill release
clawhub install muhaven-rwa-skill@latest
npm install -g @muhaven/mcp@latest
```

If the global `@muhaven/mcp` is *newer* than the skill's bundled version, the broker may still work — but the SHA-256 tool-hash pin will fail. Wait for the next skill release that bundles the new MCP version.

## Where next

- [Install the skill](/openclaw/install-skill) — full install walkthrough.
- [Telegram bot](/openclaw/telegram-bot) — link your Telegram, send commands.
- [Three confirmation tiers](/openclaw/confirmation-tiers) — the tier classifier in detail.
