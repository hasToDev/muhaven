---
title: OpenClaw — install the skill
description: Install muhaven-rwa-skill from ClawHub into your OpenClaw runtime.
---

# Install the MuHaven OpenClaw skill

`muhaven-rwa-skill` is published to ClawHub. Installing it into your OpenClaw runtime takes three steps.

## Prerequisites

- **OpenClaw runtime** installed (`npm install -g openclaw@latest`). Node 20+ required.
- **`@muhaven/mcp@0.1.3`** installed globally (the skill bundles it; the `muhaven-broker` bin needs to be on `$PATH`).
- A **MuHaven wallet** with a passkey-bound investor account.

```bash
# 1. Prereq: OpenClaw runtime + MCP
npm install -g openclaw@latest
npm install -g @muhaven/mcp@0.1.3
```

::: tip Install @muhaven/mcp first
The skill bundles `@muhaven/mcp` via a `workspace:*` rewrite at pack time. ClawHub install resolves the package from npm, but the **broker bin** (`muhaven-broker`) must be on `$PATH` for the skill to start. Globally-installing `@muhaven/mcp` before `clawhub install` puts the bin on PATH. This is documented in the skill's `config.json#post_install_review.items`.
:::

## Step 1 — Install via ClawHub

```bash
clawhub install muhaven-rwa-skill
```

What happens:

1. ClawHub downloads `muhaven-rwa-skill-0.1.2.tgz`.
2. Verifies the Sigstore signature (Rekor index pinned to the GitHub OIDC issuer `hasToDev/muhaven`).
3. Validates the manifest's permissions (network egress allowlist, no filesystem writes, no process spawn, OS-keychain-only secrets).
4. Extracts to your OpenClaw skill directory.
5. Prints a 5-item `post_install_review` checklist (broker-bin on PATH, runtime version, network egress, etc.).

::: warning ClawHub install does NOT run npm install
As of clawhub `v0.12.3`, the install step extracts the tarball but doesn't run `npm install --omit=dev`. You need to run it manually in the skill directory:

```bash
cd ~/.openclaw/skills/muhaven-rwa-skill
npm install --omit=dev
```
:::

## Step 2 — Start the broker + authorize

The skill bundle's runtime expects `muhaven-broker` on `$PATH`:

```bash
# Generate a session key (one-time)
export MUHAVEN_BROKER_SESSION_KEY=0x$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")

# Start the broker
muhaven-broker
```

In a second terminal:

```bash
muhaven-broker login
```

This opens `https://muhaven.app/link?code=...` for the passkey-bound device-code authorization. See [MCP install](/mcp/install) §Step 2 for the full flow.

## Step 3 — Run the skill

In OpenClaw:

```bash
openclaw run muhaven-rwa-skill
```

The skill's MCP server starts in stdio mode with the **11-tool subset filter** applied. OpenClaw's interface routes your messages to the bundled MCP server.

Verify with:

```
> What MuHaven tools do you have?

I have these MuHaven tools available:
- muhaven.read.portfolio
- muhaven.read.yields
- muhaven.read.distribution
- muhaven.read.tokens
- muhaven.read.audit
- muhaven.read.protection_coverage
- muhaven.read.kyc_attestation
- muhaven.position.buy
- muhaven.position.claim
- muhaven.policy.pause
- muhaven.policy.session_key_status
```

Exactly **11 tools**. If you see more or fewer, the subset filter didn't apply — file an issue.

## What the skill manifest declares

The skill's `manifest.json` declares:

```json
{
  "permissions": {
    "network": {
      "egress_allowlist": [
        "https://api.muhaven.app",
        "https://muhaven.app"
      ],
      "deny_default": true
    },
    "filesystem": { "read": [], "write": [] },
    "process": { "spawn": [] },
    "secrets": {
      "storage": "os_keychain",
      "references": [
        { "name": "muhaven_jwt", "owner": "muhaven-broker",
          "scope": ["mcp.read.*", "mcp.propose.*"] }
      ]
    }
  }
}
```

The OpenClaw runtime enforces these as a **sandbox**: any network call to a host outside the allowlist is refused; any filesystem write is refused; any `child_process.spawn` is refused.

The runtime's sandbox is the *first* line of defense. The MCP server's own checks (broker isolation, scoped JWT, no-auto-submit invariant) are the second. The on-chain policy gate is the third.

## Updating the skill

```bash
clawhub install muhaven-rwa-skill@latest
```

The skill version (`SKILL.md`/`manifest.json#version`) and the bundled MCP version (`manifest.json#mcp.bundled_version`) are version-pinned together — a skill upgrade may pull a newer `@muhaven/mcp` if the bundled version was bumped.

To check what's installed:

```bash
clawhub inspect muhaven-rwa-skill
```

## Uninstall

```bash
clawhub uninstall muhaven-rwa-skill
muhaven-broker logout
npm uninstall -g @muhaven/mcp        # optional — keeps the broker bin around if you want
```

## Where next

- [Telegram bot](/openclaw/telegram-bot) — link your Telegram for the conversational interface.
- [Three confirmation tiers](/openclaw/confirmation-tiers) — how confirmations actually work.
- [Available tools](/openclaw/tools) — the 11 tools, what each does.
