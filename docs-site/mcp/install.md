---
title: '@muhaven/mcp — install'
description: From npm install to a logged-in broker in three commands.
---

# Install `@muhaven/mcp`

Three steps from a fresh machine to a working MCP install:

1. Install the package globally.
2. Start the broker and complete the device-code login.
3. Wire your host's MCP config and restart.

## Prerequisites

- **Node 20 or later** (for the broker daemon).
- **A MuHaven account** with a passkey-bound kernel (sign up on `muhaven.app` — takes 60 seconds).
- **An MCP-aware host:** Claude Code, Claude Desktop, or Cursor.

## Step 1 — Install globally

```bash
npm install -g @muhaven/mcp
```

This installs two binaries:

- `muhaven-mcp` — the STDIO subprocess your LLM host spawns.
- `muhaven-broker` — the long-lived per-user daemon.

Verify the binaries are on your PATH:

```bash
muhaven-broker --help
muhaven-mcp --help
```

::: tip On Windows / WSL2 / SSH-remote: set `MUHAVEN_KEYRING=file`
The default keyring uses your OS keychain (Keychain on macOS, Secret Service on Linux, Credential Manager on Windows). On WSL2, devcontainers, and SSH-remote shells, that's often unavailable. Set `MUHAVEN_KEYRING=file` to use a 0600-mode file at `~/.muhaven/jwt.json` instead.
:::

## Step 2 — Mint a session key, start the broker, log in

Today (until the dashboard mint UI ships), you self-mint a 32-byte session key:

```bash
# 1. Generate a session key (one-time)
export MUHAVEN_BROKER_SESSION_KEY=0x$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")

# 2. (Optional) point at staging instead of prod
# export MUHAVEN_BACKEND_URL=https://api-stage.muhaven.app

# 3. (Optional) file keyring on WSL2 / devcontainer / SSH-remote
# export MUHAVEN_KEYRING=file

# 4. Start the broker (leave running in this terminal)
muhaven-broker
```

In a second terminal:

```bash
# 5. One-time device-code login
muhaven-broker login
```

This:

1. Opens your default browser to `https://muhaven.app/link?code=ABCD-1234`.
2. The `/link` page shows the **requesting client metadata** (name, scopes, fingerprint) — verify it matches the broker you just started.
3. You authorize with your passkey.
4. The broker receives a scoped JWT (`mcp.read.*` + `mcp.propose.*`) and stores it in your OS keychain (or `~/.muhaven/jwt.json` with file keyring).

The login JWT is currently **1 hour**. After expiry, run `muhaven-broker login` again.

Verify:

```bash
muhaven-broker doctor
```

Outputs your bound wallet address, the scopes on your JWT, the keystore location, and the broker socket path.

## Step 3 — Wire your host

### Claude Code

Add an entry to your global `.mcp.json` (typically `~/.claude/.mcp.json`):

```json
{
  "mcpServers": {
    "muhaven": {
      "command": "muhaven-mcp"
    }
  }
}
```

If you installed with `npm install -g`, the `muhaven-mcp` binary is on your PATH. If you installed locally (`npm install`), use the absolute path:

```json
{
  "mcpServers": {
    "muhaven": {
      "command": "node",
      "args": ["/abs/path/to/node_modules/@muhaven/mcp/bin/muhaven-mcp.cjs"]
    }
  }
}
```

Restart Claude Code. The next time you start a chat, `muhaven` appears in the MCP server list and the 22 tools are available.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "muhaven": {
      "command": "muhaven-mcp"
    }
  }
}
```

Restart Claude Desktop. The MCP tools surface in the chat composer's tool dropdown.

::: warning Claude Desktop on Windows: PATH may not propagate
Claude Desktop on Windows sometimes runs in a sandbox that doesn't see your user PATH. If `muhaven-mcp` isn't found, use the absolute path: `"C:\\Users\\you\\AppData\\Roaming\\npm\\muhaven-mcp.cmd"`.
:::

### Cursor

Cursor's MCP config is at `~/.cursor/mcp.json` (or via the Cursor settings UI → MCP):

```json
{
  "mcpServers": {
    "muhaven": {
      "command": "muhaven-mcp"
    }
  }
}
```

Restart Cursor. The Tools panel will list the MuHaven tools.

::: tip Use the right host-config snippet
The exact host-config format hasn't been stress-tested across every Cursor / Claude Desktop release. If your host advertises a slightly different `mcpServers` shape, follow the host's docs — the `command: "muhaven-mcp"` value stays the same.
:::

## Read-only mode

If you want a "give my LLM read-only visibility" deployment (shared workstation, curated investor dashboard, etc.), set `MUHAVEN_READ_ONLY=true` in the broker env before starting:

```bash
export MUHAVEN_READ_ONLY=true
muhaven-broker
```

Only the **seven `muhaven.read.*` tools** will be registered. Position / policy / issuer / governance groups are not even surfaced to the host LLM — defense in depth. See [Read-only mode](/mcp/read-only-mode).

## Multiple installs (e.g., a staging install for testing)

You can run two broker instances side by side:

```bash
# Terminal A — prod broker
muhaven-broker

# Terminal B — staging broker on a different socket
export MUHAVEN_BACKEND_URL=https://api-stage.muhaven.app
export MUHAVEN_BROKER_SOCKET=/tmp/muhaven-broker-stage.sock
muhaven-broker
```

Wire each to a different host config entry (e.g., `muhaven` and `muhaven-stage` keys in your `.mcp.json`).

## Verify end-to-end

In your host:

```
> What does my muhaven portfolio look like?
```

Should produce a tool call to `muhaven.read.portfolio` and return your aggregate state. If you get an auth error, run `muhaven-broker doctor` to inspect your JWT status.

## Uninstall

```bash
muhaven-broker logout                # revokes the broker JWT in keychain
npm uninstall -g @muhaven/mcp        # removes the binaries
# (optional) rm -rf ~/.muhaven       # removes any file-keyring data
```

The kernel itself is on-chain and unaffected by uninstalling MCP — sign in to the dashboard with your passkey and your account is fully intact.

## Where next

- [First chat](/mcp/first-chat) — walk through your first portfolio query.
- [Tool catalog](/mcp/tools) — the 22 tools you have access to.
- [Broker daemon](/mcp/broker) — what the broker actually does.
- [Troubleshooting](/mcp/troubleshooting) — common install issues.
