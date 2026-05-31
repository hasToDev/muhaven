---
title: '@muhaven/mcp — install'
description: From npm install to a logged-in broker in three commands.
---

# Install `@muhaven/mcp`

Three commands. That's the whole happy path.

## Prerequisites

- **Node 20 or later**
- **A MuHaven account** with a passkey-bound wallet (sign up at `muhaven.app`)
- **An MCP-aware host:** Claude Code, Claude Desktop, or Cursor

## Step 1 — Install globally

```bash
npm install -g @muhaven/mcp@0.6.1
```

::: tip Latest version
The current published release is **`@muhaven/mcp@0.6.1`**. To always grab the newest, drop the version tag — but pinning is recommended so an upstream change can't surprise a live demo.
:::

## Step 2 — One-shot setup

```bash
muhaven-broker setup --register claude-code
```

**This one command does everything** — you don't need to set any environment variables manually:

- Sets `MUHAVEN_BACKEND_URL` and `MUHAVEN_DASHBOARD_URL` automatically (when unset)
- Detects your platform and configures the keyring (OS keychain on macOS/Linux desktop; file keyring on Windows, WSL2, devcontainers, and SSH-remote shells)
- Mints a session key into `MUHAVEN_BROKER_SESSION_KEY`
- Starts the broker daemon in the background
- Opens your browser to complete a one-time passkey login (`https://muhaven.app/link?code=…`)
- Registers the MCP server with Claude Code via `claude mcp add-json`

After the browser login, the broker stores a scoped JWT (`mcp.read.*` + `mcp.propose.*`) in your OS keychain (or `~/.muhaven/jwt.json` on platforms where the keychain is unavailable).

::: tip On Windows / WSL2 / SSH-remote
The setup command detects these environments and applies `MUHAVEN_KEYRING=file` automatically. See [Advanced & manual setup](#advanced-manual-setup) below if you need to override this behaviour.
:::

Verify with:

```bash
muhaven-broker doctor
```

This prints your bound wallet address, JWT scopes, keystore location, and broker socket path.

## Step 3 — Restart your host and verify

Restart Claude Code (or your MCP host). Then ask:

```
> What does my muhaven portfolio look like?
```

This calls `muhaven.read.portfolio` and returns your aggregate portfolio state. If you get an auth error, run `muhaven-broker doctor`.

The login JWT expires after **1 hour**. To refresh: `muhaven-broker login` (or re-run `muhaven-broker setup`).

---

## Advanced & manual setup

The happy path above covers most installs. Read on if you are on a non-Claude-Code host (Claude Desktop, Cursor), want to set variables manually, run a supervised daemon, or install a staging instance.

### Manual registration (Claude Desktop, Cursor, or if `--register` printed a warning)

#### Claude Code — manual

If the `--register claude-code` step failed or you prefer to do it yourself:

```bash
claude mcp add-json muhaven '{"type":"stdio","command":"muhaven-mcp","env":{"MUHAVEN_BACKEND_URL":"https://api.muhaven.app","MUHAVEN_DASHBOARD_URL":"https://muhaven.app"}}' --scope user
```

`--scope user` writes to `~/.claude.json` so every project on this machine sees the server. Use `--scope project` to write `.mcp.json` in the current directory instead, or `--scope local` for per-project user-only entries.

::: tip Why the official CLI instead of editing JSON by hand?
`claude mcp add-json` handles scope semantics, idempotency, and future migration to URL-elicitation flows cleanly. Hand-edited `.mcp.json` files still work, but the CLI is the supported path.
:::

#### Claude Desktop

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

#### Cursor

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

### Manual five-step setup (without `muhaven-broker setup`)

If you need full control over each step — for example when scripting a CI environment:

```bash
# Terminal A
export MUHAVEN_BROKER_SESSION_KEY=0x$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
export MUHAVEN_KEYRING=file                            # if on Windows / WSL2 / SSH
export MUHAVEN_BACKEND_URL=https://api.muhaven.app
export MUHAVEN_DASHBOARD_URL=https://muhaven.app
muhaven-broker                                          # leave running

# Terminal B
muhaven-broker login                                    # passkey ceremony
```

### Keyring: file fallback (`MUHAVEN_KEYRING=file`)

By default the broker uses your OS keychain:

| Platform | Backed by |
|---|---|
| macOS | Keychain Access (login keychain) |
| Linux | Secret Service (libsecret + GNOME Keyring / KWallet) |
| Windows | Credential Manager |

On WSL2, devcontainers, and SSH-remote shells the keychain is typically unavailable. Set `MUHAVEN_KEYRING=file` to store the JWT at `~/.muhaven/jwt.json` (created with `umask(0077)`; cleared on `muhaven-broker logout`). The `setup` command applies this automatically when it detects these environments.

### Supervised daemon (`--foreground`)

If systemd / launchd / a process supervisor will own the broker daemon's lifecycle:

```bash
muhaven-broker setup --foreground
```

This applies env defaults and mints the session key, then runs the daemon **attached** so the supervisor can capture stderr and handle restarts. The browser login step is skipped in foreground mode — run `muhaven-broker login` afterward from a second shell.

### Multiple installs (e.g., a staging instance)

You can run two broker instances side by side:

```bash
# Terminal A — prod broker (default)
muhaven-broker

# Terminal B — staging broker on a different socket
export MUHAVEN_BACKEND_URL=https://api-stage.muhaven.app
export MUHAVEN_BROKER_SOCKET=/tmp/muhaven-broker-stage.sock
muhaven-broker
```

Wire each to a different host config entry (e.g., `muhaven` and `muhaven-stage` keys in your `.mcp.json`).

### Read-only mode

Set `MUHAVEN_READ_ONLY=true` before starting the broker to register **only the eight `muhaven.read.*` tools**. Position, cash, policy, issuer, and governance tools are not surfaced to the host LLM at all — defense in depth for shared workstations or curated deployments.

```bash
export MUHAVEN_READ_ONLY=true
muhaven-broker
```

See [Read-only mode](/mcp/read-only-mode) for the full reference.

---

## Hands-off auto-reinvest: the `muhaven-reinvest` runner

`@muhaven/mcp@0.6.1` ships a second, optional binary — **`muhaven-reinvest`** — a keyless
runner that automatically **claims matured yield and reinvests it** into a token you choose,
all within the bounds of a Scoped session you've granted (it never holds your passkey).

It's opt-in and budget-capped. Typical setup, after the broker is logged in (Step 2):

```bash
# Set a per-cycle budget (in mhUSDC). A non-zero budget IS the opt-in;
# leave it at 0 (or unset to the $1 default) to control how much it may deploy.
export MUHAVEN_REINVEST_BUDGET_USD=1        # per-cycle ceiling; 0 disables the runner
muhaven-reinvest
```

The runner reuses the broker's scoped session (same security split — it signs only
placeholder-intent hashes, never a raw key) and logs every action to your
[audit log](/policy/audit-log). To stop it, end the process; to revoke its authority
instantly, [pause](/policy/pause) or step the tier down to **Advisory**.

::: tip This is the autonomous path
Auto-reinvest is part of MuHaven's **Scoped** autonomy. See the
[autonomous-execution walkthrough](/guide/agent/autonomous) for the end-to-end flow and how
to grant the Scoped session it depends on.
:::

## Uninstall

```bash
muhaven-broker logout                # revokes the broker JWT in keychain
npm uninstall -g @muhaven/mcp        # removes the binaries
# (optional) rm -rf ~/.muhaven       # removes any file-keyring data
```

Your MuHaven wallet itself is on-chain and unaffected by uninstalling MCP — sign in to the dashboard with your passkey and your account is fully intact.

## Where next

- [First chat](/mcp/first-chat) — walk through your first portfolio query.
- [Tool catalog](/mcp/tools) — the tools you have access to.
- [Broker daemon](/mcp/broker) — what the broker actually does.
- [Autonomous execution](/guide/agent/autonomous) — grant a Scoped session and let the agent act.
- [Troubleshooting](/mcp/troubleshooting) — common install issues.
