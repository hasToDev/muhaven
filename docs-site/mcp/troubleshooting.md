---
title: '@muhaven/mcp — troubleshooting'
description: Symptom → fix for the most common MCP install and auth issues.
---

# MCP troubleshooting

A symptom-first reference. Start by running `muhaven-broker doctor` — it surfaces 80% of issues in one line.

## Install

### "Command not found: muhaven-broker"

You installed locally (not globally). Either:

```bash
npm install -g @muhaven/mcp                # makes both bins global
# or use the local path
./node_modules/.bin/muhaven-broker --version
```

### "EACCES: permission denied" on Linux/macOS

Either:

- `sudo npm install -g @muhaven/mcp` (root-installed global), or
- Use a Node version manager (nvm / fnm / volta) so `npm install -g` doesn't need root.

### "Cannot find module '@napi-rs/keyring'"

The keyring native module didn't install for your platform. Two paths:

1. Reinstall: `npm install -g @muhaven/mcp --force` (forces the native postinstall).
2. Use the file fallback: `export MUHAVEN_KEYRING=file` and restart the broker.

### Windows: "muhaven-mcp.cmd not found by Claude Desktop"

Claude Desktop on Windows sometimes runs in a sandbox that doesn't see your user PATH. Use the absolute path in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "muhaven": {
      "command": "C:\\Users\\you\\AppData\\Roaming\\npm\\muhaven-mcp.cmd"
    }
  }
}
```

## Authentication

### "Device-code flow opens browser but `/link` page is blank"

Two possibilities:

1. **The backend isn't reachable.** Check `https://api.muhaven.app/health` returns `{"status":"ok"}`.
2. **You're not signed into the dashboard.** Open `https://muhaven.app` first, sign in with your passkey, then re-run `muhaven-broker login`.

### "Authorized in the browser, but broker still says `awaiting authorization`"

The broker polls every 5 seconds. Give it 10-15 seconds. If it still says awaiting:

- Check the broker terminal for an error message.
- The device code may have expired (5-minute TTL). Re-run `muhaven-broker login`.

### "`401 UNAUTHORIZED` on every tool call"

Your JWT expired (default 1h). Run `muhaven-broker login` again.

If it persists right after login, check `muhaven-broker doctor` — the `keystore` line tells you where the JWT was actually stored. On WSL2 / devcontainer, you may need `export MUHAVEN_KEYRING=file`.

### "`403 NOT_APPROVED_ISSUER` on an issuer tool"

Either:

- You're signed in with your investor passkey. Issuer tools require your **issuer's MuHaven wallet** — see [Investor vs issuer](/get-started/investor-vs-issuer).
- Your issuer status isn't `approved`. Visit `/apply-issuer` on the dashboard.

### "`423 PAUSED` on every propose call"

Your agent is paused. Sign in to the dashboard at `muhaven.app/agent` and resume. The resume ceremony involves a WebAuthn passkey signature that MCP can't drive (no DOM).

## Transport

### "ECONNREFUSED on `/tmp/muhaven-broker.sock`"

The broker isn't running. In a separate terminal:

```bash
muhaven-broker
```

If the broker terminal says it's listening but you still get `ECONNREFUSED`, you may have a socket path mismatch. Set explicitly:

```bash
# Broker terminal
export MUHAVEN_BROKER_SOCKET=/tmp/muhaven-broker.sock
muhaven-broker

# MCP server (host config)
{ "env": { "MUHAVEN_BROKER_SOCKET": "/tmp/muhaven-broker.sock" } }
```

### "PARSE_ERROR from broker"

The MCP server sent malformed JSON. This is usually a version mismatch — your `muhaven-mcp` and `muhaven-broker` are from different `@muhaven/mcp` versions. Reinstall:

```bash
npm install -g @muhaven/mcp@latest
```

Both bins ship from the same package; updating it updates both.

### "Stuck handshake (`hello` not responding)"

The broker is hung. SIGTERM it:

```bash
muhaven-broker stop
# or in the broker terminal: Ctrl-C
```

Then restart. If it hangs again on startup, check `~/.muhaven/` for a stale lock file and remove it.

## Lifecycle

### "MCP server exits immediately on host start"

Pre-2026-05-10 versions of `@muhaven/mcp` had a known bin-lifecycle bug where `bin/*.cjs` would `process.exit(0)` before the STDIO transport could keep the event loop alive. Symptom: the host says the MCP server exited code 0 within seconds of spawn.

Fix: update to `@muhaven/mcp@0.1.2` or later. The bug is fixed in the upgrade.

### "Tool descriptions changed → server exits with code 70"

`tool-hashes.json` SHA-256 verification fired and detected drift. This is intentional — the description is part of the security contract.

If you legitimately updated `@muhaven/mcp` and want to accept the new hashes:

```bash
cd $(npm root -g)/@muhaven/mcp
pnpm verify-tool-hashes        # re-pin hashes from current descriptions
```

You should only run this if you trust the new descriptions (e.g., you intentionally upgraded). On a "wait, I didn't update?" failure, investigate before re-pinning.

## Tools

### "LLM refuses to call a tool that should exist"

Two possibilities:

- **Read-only mode is on.** Check the broker terminal for `READ-ONLY MODE` banner. To allow propose tools, restart without `MUHAVEN_READ_ONLY=true`.
- **Tier-gated and you're paused.** Most propose tools require unpause first.

### "LLM auto-submits a buy I didn't expect"

This shouldn't happen. Position tools return descriptors only; they never auto-submit. If you see an apparent auto-submit:

1. Check your dashboard audit log at `/agent → Audit`. If there's a `permit_granted` row, the action did settle on a dashboard surface (not from MCP directly).
2. If the tool call output included an `audit_id`, that's a *propose-time* audit row (not a commit). Commit requires a dashboard ConfirmModal step.

File an issue if you can reproduce auto-submission from MCP itself — it would be a security bug.

### "Distribute yield says my token has zero holders"

The `InvestorRegistry` is read at propose time. If you added KYC entries within the last 30 seconds, the indexer may not have caught up. Wait and re-propose.

## Where next

- [Install](/mcp/install) — full install walkthrough.
- [First chat](/mcp/first-chat) — verify your install end-to-end.
- [Broker daemon](/mcp/broker) — what the broker does and how.
