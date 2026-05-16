---
title: '@muhaven/mcp — overview'
description: Bring your own LLM. Drive MuHaven from Claude Code, Claude Desktop, or Cursor.
---

# `@muhaven/mcp`

`@muhaven/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io/) server that turns any MCP-aware LLM host (Claude Code, Claude Desktop, Cursor, future MCP hosts) into a front-end for your MuHaven RWA portfolio.

You install it once, complete a one-time passkey-bound device authorization, and from then on you can ask **the LLM you already trust** to read your encrypted-balance portfolio, propose trades, manage policy, and — if you're an issuer — drive distributions and KYC. All without ever pasting an API key, an RPC URL, or a private key into an LLM context.

## What you get

| | |
|---|---|
| **Package** | `@muhaven/mcp` on npm (published with OIDC + Sigstore provenance) |
| **Format** | MCPB (Model Context Protocol Bundle) — official MCP package format |
| **Binaries** | `muhaven-mcp` (STDIO subprocess) + `muhaven-broker` (long-lived per-user daemon) |
| **Tools** | 22 across 5 groups: read · position · policy · issuer · governance |
| **Auth** | OAuth 2.0 Device Authorization Grant (RFC 8628) → scoped JWT in OS keychain |
| **Hosts** | Claude Code (verified end-to-end), Claude Desktop and Cursor (same `.mcp.json` shape) |

## Architecture in one diagram

```
┌─── Your machine ──────────────────────────────────────────┐
│                                                            │
│  Claude Code / Claude Desktop / Cursor                     │
│   │ STDIO (JSON-RPC)                                       │
│   ▼                                                        │
│  muhaven-mcp ─── named pipe / Unix socket ──► muhaven-     │
│   │              (broker holds JWT + sig key)   broker     │
│   │                                                        │
│   │ HTTPS to the MuHaven backend                           │
└───┼────────────────────────────────────────────────────────┘
    ▼
  https://api.muhaven.app/api/v1/...
```

Two processes on **your** machine:

1. **`muhaven-mcp`** — a STDIO subprocess the host LLM spawns on demand. Speaks JSON-RPC to the host, HTTPS to the MuHaven backend. **Never** sees your signing key.
2. **`muhaven-broker`** — a long-lived per-user daemon. Holds the JWT and the ZeroDev session-key private half in your OS keychain. Listens on a Unix socket (POSIX) or named pipe (Windows). **Never** speaks TCP.

The split is the load-bearing security control: an attacker who jailbreaks the LLM cannot exfiltrate your signing key without also compromising a separate process running under your user.

## When to use MCP vs the other surfaces

| Question | If yes → MCP |
|---|---|
| Do you already chat with Claude / a host LLM every day? | ✅ |
| Do you want to sit MuHaven next to Notion / GitHub / Gmail MCPs in one chat? | ✅ |
| Do you have a budget for your own LLM tokens? | ✅ |
| Do you want a guided wizard with click-through previews? | ❌ Use [HavenBot](/havenbot/overview) |
| Do you want phone-first one-tap actions? | ❌ Use [Telegram](/openclaw/telegram-bot) |

Five reasons to pick MCP over HavenBot:

1. **Use the LLM you already trust.** Not locked to MuHaven's server-managed LLM. Connect Claude Sonnet 4.6, Claude Opus 4.7, or any future model your host supports — bring your own provider key.
2. **Multi-agent workflows.** Sit MuHaven alongside your other MCP servers. "Pull my MuHaven portfolio + cross-reference with my Notion investment thesis + email a summary to my CPA via Gmail" becomes one chat turn.
3. **Privacy by construction.** The MCP server NEVER decrypts FHE handles. The LLM NEVER sees your private key (broker holds it). Your host's LLM context never sees your JWT (the broker holds that too).
4. **Programmatic automation.** Once installed, the same surface is available to scheduled cron-style automations: "every Friday at 17:00, check yields and propose a claim if any are >$10."
5. **Open standards.** Built on MCP (Anthropic / open spec), OAuth 2.0 Device Authorization Grant (RFC 8628), ZeroDev passkey kernel (EIP-4337), Sigstore signing. Nothing proprietary.

## What MCP looks like in Claude Code

```
$ claude

> What does my muhaven portfolio look like?

[muhaven] muhaven.read.portfolio()
{
  "positions": [],
  "total_tokens": 0
}

Your MuHaven portfolio is empty — you don't hold any RWA tokens yet.
Want me to draft a buy proposal? I can call muhaven.position.buy with
an amount and token of your choice.
```

The LLM sees only the **aggregate** the backend chose to return. No encrypted handle, no cleartext balance. If you ask "buy 100 mhUSDC of TBILL1", the LLM produces a tool_call → the broker signs → the result is an unsigned UserOp envelope. The LLM never auto-submits.

## What ships today (Wave 4 close)

✅ MCPB-format package at `packages/mcp/`
✅ Two CLI binaries (`muhaven-mcp`, `muhaven-broker`)
✅ OAuth 2.0 Device Authorization Grant (RFC 8628) — same UX shape as `gh auth login --web`, `wrangler login`, `gcloud auth login`
✅ Tool-description SHA-256 pinning (`tool-hashes.json`) re-verified on every server startup; drift exits with code 70 (`EX_CONFIG`)
✅ Broker daemon over Unix socket / named pipe, OS keychain (`@napi-rs/keyring`) with file fallback
✅ Published on npm with OIDC + Sigstore provenance (`@muhaven/mcp@0.1.2`)
✅ 94 vitest cases (incl. bin-lifecycle regressions caught during the 2026-05-10 first end-to-end install)

## What's deferred to Wave 5

- ⏸ **Dashboard session-key mint UI** at `/settings/policy`. Today users self-mint with `node -e "console.log('0x' + require('crypto').randomBytes(32).toString('hex'))"`.
- ⏸ **MCPB host-store distribution.** Once Anthropic's MCPB extension store opens to third-party publishers, MuHaven MCP becomes a one-click install in Claude Desktop.
- ⏸ **Frontend runner for `governance.cast_vote`** — pending the cofhe encrypt-vote SDK helper.

## Where next

<div class="mh-card-grid">
  <a class="mh-card" href="/mcp/install">
    <h3>Install</h3>
    <p>Get @muhaven/mcp running in Claude Code, Desktop, or Cursor.</p>
  </a>
  <a class="mh-card" href="/mcp/first-chat">
    <h3>First chat</h3>
    <p>Walk through your first portfolio query end-to-end.</p>
  </a>
  <a class="mh-card" href="/mcp/tools">
    <h3>Tool catalog</h3>
    <p>The 22 tools across read / position / policy / issuer / governance.</p>
  </a>
  <a class="mh-card" href="/mcp/broker">
    <h3>Broker daemon</h3>
    <p>How the broker handles your keys, sockets, and OS keychain.</p>
  </a>
</div>
