---
title: Install & verify the MCP server
description: Install @muhaven/mcp on your own machine, log in with a passkey, and verify the broker end-to-end.
---

# Install & verify the MCP server

<TaskMeta time="~5 min" role="Investor" needs="Node 20+, a MuHaven passkey wallet, an MCP-aware host (Claude Code/Desktop/Cursor)" />

> **What you'll do:** install the `@muhaven/mcp` terminal server, log in with your passkey, run a verification ritual, then ask **your own LLM** "what's my portfolio?" and watch it call a MuHaven read tool.

This is the entry point to the **MCP track** — driving your confidential MuHaven portfolio
from **your own LLM host** (Claude Code, Claude Desktop, Cursor) instead of the in-dashboard
HavenBot copilot. For the deep reference, see [/mcp/install](/mcp/install) and
[/mcp/troubleshooting](/mcp/troubleshooting).

## Before you begin
::: info Prerequisites
- **Node 20 or later.**
- A **MuHaven account** with a passkey-bound wallet — sign up at [muhaven.app](https://muhaven.app) if you haven't (see [I1 · Sign in](/guide/investor/sign-in)).
- An **MCP-aware host**: Claude Code, Claude Desktop, or Cursor.
:::

## Step 1 — Install globally and verify the binaries

```bash
npm install -g @muhaven/mcp@0.6.2
```

This installs two binaries — `muhaven-broker` (the long-lived per-user daemon) and
`muhaven-mcp` (the STDIO subprocess your host spawns). Confirm they're on your PATH:

```bash
muhaven-broker --help
muhaven-mcp --help
```

**Expected:** each prints usage text. If you see `command not found`, your npm global bin
isn't on PATH — see Troubleshooting below.

## Step 2 — Set up + register your host

```bash
muhaven-broker setup --register claude-code
```

**Expected:** the command, in order —

1. **Applies env defaults** (`MUHAVEN_BACKEND_URL`, `MUHAVEN_DASHBOARD_URL`; and `MUHAVEN_KEYRING=file` on Windows/WSL2/SSH).
2. **Mints an ephemeral session key**.
3. **Spawns the broker daemon** detached in the background.
4. **Opens your browser** to `muhaven.app/link?code=…` for a **device-code passkey approval** — review the requesting client (name, scopes, fingerprint) and approve with your passkey.
5. **Registers the host** (`claude mcp add-json muhaven …`).
6. **Prints a closing summary** with the daemon PID + endpoint + the stop command.

## Step 3 — Verify the broker with `doctor`

```bash
muhaven-broker doctor
```

**Expected output** includes:

- your **bound wallet address** — `0x…`
- the **JWT scopes** — `mcp.read.*` plus `mcp.propose.*`
- the **keystore location** (OS keychain, or `~/.muhaven/jwt.json` with the file keyring)
- the **broker socket path**

## Step 4 — Restart your host and ask it to read your portfolio

Restart your MCP host so it picks up the newly registered `muhaven` server, then prompt:

```
> What does my muhaven portfolio look like?
```

**Expected:** your LLM makes a **`muhaven.read.portfolio`** tool call and returns your
aggregate state (aggregates and encrypted handles — never your cleartext balances).

## Expected result
<ExpectedResult>
Your host lists the <strong>muhaven</strong> MCP server, and asking <em>"what's my
portfolio?"</em> produces a <code>muhaven.read.portfolio</code> tool call that returns your
aggregate state — no passkey prompt, no transaction (reads are free).
</ExpectedResult>

## Troubleshooting

| Symptom | Fix |
|---|---|
| `muhaven-broker: command not found` | Your npm global bin isn't on PATH. Add npm's global bin dir (find it with `npm bin -g`) to your shell PATH, then reopen the terminal. |
| Browser didn't open, or the login link expired | Re-run `muhaven-broker setup`. The login JWT is ~1 hour — re-running re-opens `muhaven.app/link`. |
| `doctor` shows no JWT / an auth error | The daemon is up but not logged in — run `muhaven-broker login` and approve with your passkey. |
| Host doesn't list the `muhaven` server / its 25 tools | Restart the host, and check the host's MCP config (`claude mcp list` for Claude Code, or the host's MCP settings). |
| Windows / WSL2 / SSH keyring error | The OS keychain is unavailable on that surface — `export MUHAVEN_KEYRING=file` (a 0600-mode file at `~/.muhaven/jwt.json`), then re-run setup. |

For deeper coverage see the full [MCP install reference](/mcp/install) and
[MCP troubleshooting](/mcp/troubleshooting).

→ Next: [Read your portfolio via MCP](/guide/mcp/reads)
