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
- **A MuHaven account** with a passkey-bound MuHaven wallet (sign up on `muhaven.app`).
- **An MCP-aware host:** Claude Code, Claude Desktop, or Cursor.

## Step 1 — Install globally

Pin the current release so you get a known-good build:

```bash
npm install -g @muhaven/mcp@0.6.1
```

::: tip Latest version
The current published release is **`@muhaven/mcp@0.6.1`**. To always grab the newest,
drop the version tag (`npm install -g @muhaven/mcp`) — but pinning is recommended so an
upstream change can't surprise a live demo.
:::

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

## Step 2 — One-shot setup with auto-register

```bash
muhaven-broker setup --register claude-code
```

That one command does everything:

1. **Env defaults** — `MUHAVEN_BACKEND_URL=https://api.muhaven.app` and `MUHAVEN_DASHBOARD_URL=https://muhaven.app` are applied when unset. On Windows, WSL2, devcontainers, Codespaces, and SSH-remote shells, `MUHAVEN_KEYRING=file` is auto-applied too (the OS keychain is typically unavailable or unwise on those surfaces). Native macOS / Linux desktop leaves the keyring on the default (OS keychain).
2. **Session key** — mints an ephemeral 32-byte key into `MUHAVEN_BROKER_SESSION_KEY` if not already present.
3. **Daemon** — spawns the broker daemon detached in the background. Idempotent: if a daemon is already running, this step is skipped.
4. **Device-code login** — opens your default browser to `https://muhaven.app/link?code=ABCD-1234`. Verify the requesting client metadata (name, scopes, fingerprint) matches the broker you just started, then approve with your passkey. The broker receives a scoped JWT (`mcp.read.*` + `mcp.propose.*`) and stores it in your OS keychain (or `~/.muhaven/jwt.json` with file keyring).
5. **Host register** *(new in 0.1.6, requires `--register HOST` flag)* — shells out to `claude mcp add-json muhaven '<json>' --scope user`. Removes any prior `muhaven` entry first (idempotent). Default scope is `user` so every project on this machine sees the server. Pass `--register-scope project` to write `.mcp.json` in the current directory instead, or `--register-scope local` for per-project user-only entries.
6. **Closing summary** — prints the daemon PID + endpoint + the command to stop it later.

::: tip Why `--register` instead of editing `.mcp.json` by hand?
Pre-0.1.6 the operator had to `cat > .mcp.json` with a hand-rolled JSON block. `--register claude-code` calls the official `claude mcp add-json` CLI, so the host config gets the same shape Claude Code's own tooling writes. Reserved host names (`claude-desktop`, `cursor`) parse but print a "not implemented" hint — file-edit registrars for those hosts land in a follow-up release.
:::

The login JWT is currently **1 hour**. After expiry, run `muhaven-broker setup` again (or just `muhaven-broker login` if the daemon is still running).

::: tip Supervised daemon? Use `--foreground`
If systemd / launchd / a process supervisor will own the broker daemon's lifecycle, run `muhaven-broker setup --foreground` (or `-f`) — that path applies env defaults + mints the session key, then runs the daemon attached so the supervisor can see its stderr + handle restarts. The login step is skipped in foreground mode (run `muhaven-broker login` afterward from a second shell).
:::

Verify:

```bash
muhaven-broker doctor
```

Outputs your bound wallet address, the scopes on your JWT, the keystore location, and the broker socket path.

### What if I want to do this manually?

The five-step ritual `setup` replaces is still available:

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

## Step 3 — Wire your host

### Claude Code

**If you ran `muhaven-broker setup --register claude-code` in Step 2, you're done.** Skip to "Verify end-to-end" below.

If you want to register manually (or your `--register` step printed a warning), use the official `claude mcp` CLI:

```bash
claude mcp add-json muhaven '{"type":"stdio","command":"muhaven-mcp","env":{"MUHAVEN_BACKEND_URL":"https://api.muhaven.app","MUHAVEN_DASHBOARD_URL":"https://muhaven.app"}}' --scope user
```

The CLI writes the entry into `~/.claude.json`. `--scope project` writes `.mcp.json` in the current directory instead (committed to your team's repo); `--scope local` writes a per-project user-only entry (Claude Code's default).

::: tip Why the official CLI instead of editing JSON by hand?
The `claude mcp add-json` command shipped in 2025-Q4 alongside MCP Elicitation support and is the supported way to register a server. Hand-edited `.mcp.json` files still work, but the CLI handles scope semantics + idempotency + the future migration to URL-elicitation flows cleanly.
:::

Restart Claude Code. The next time you start a chat, `muhaven` appears in the MCP server list and the 25 tools are available.

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

Only the **eight `muhaven.read.*` tools** will be registered. Position / cash / policy / issuer / governance groups are not even surfaced to the host LLM — defense in depth. See [Read-only mode](/mcp/read-only-mode).

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

Your MuHaven wallet itself is on-chain and unaffected by uninstalling MCP — sign in to the dashboard with your passkey and your account is fully intact.

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
Auto-reinvest is part of MuHaven's **Scoped (Path D)** autonomy. See the
[autonomous-execution walkthrough](/guide/agent/autonomous) for the end-to-end flow and how
to grant the Scoped session it depends on.
:::

## Where next

- [First chat](/mcp/first-chat) — walk through your first portfolio query.
- [Tool catalog](/mcp/tools) — the tools you have access to.
- [Broker daemon](/mcp/broker) — what the broker actually does.
- [Autonomous execution](/guide/agent/autonomous) — grant a Scoped session and let the agent act.
- [Troubleshooting](/mcp/troubleshooting) — common install issues.
