---
title: Install & set up the MCP server
description: Install @muhaven/mcp, paste your dashboard-minted Scoped key when prompted, and verify the broker end-to-end.
---

# Install & set up the MCP server

<TaskMeta time="~5 min" role="Investor" needs="Node 20+, a Scoped session key from M1, an MCP-aware host (Claude Code/Desktop/Cursor)" />

> **What you'll do:** install the `@muhaven/mcp` terminal server, **paste the Scoped session key you minted in [M1](/guide/mcp/arm-scoped)** when `setup` prompts, verify the broker, then ask **your own LLM** "what's my portfolio?" and watch it call a MuHaven tool.

This is the install step of the **MCP track** — driving your confidential MuHaven portfolio
from **your own LLM host** (Claude Code, Claude Desktop, Cursor) instead of the in-dashboard
HavenBot copilot. For the deep reference, see [/mcp/install](/mcp/install) and
[/mcp/troubleshooting](/mcp/troubleshooting).

## Before you begin
::: info Prerequisites
- **Node 20 or later.**
- A **Scoped session key** copied from the dashboard — do [M1 · Arm Scoped autonomy](/guide/mcp/arm-scoped) first. (You *can* skip it and let `setup` mint a read/propose-only key, but then trades fall back to a dashboard deep-link.)
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

## Step 2 — Set up, and paste your Scoped key when prompted

```bash
muhaven-broker setup --register claude-code
```

As it runs, `setup` asks:

```
Do you have a session key from the dashboard? [Y/n]
```

Answer **`Y`**, then **paste the raw Scoped key you copied in [M1](/guide/mcp/arm-scoped)** at
the `Paste the session key:` prompt (your input is hidden). `setup` then, in order —

1. **Applies env defaults** (`MUHAVEN_BACKEND_URL`, `MUHAVEN_DASHBOARD_URL`; and `MUHAVEN_KEYRING=file` on Windows/WSL2/SSH).
2. **Brings the broker up on your Scoped key** — the daemon now signs trades with the signer your dashboard session authorized.
3. **Opens your browser** to `muhaven.app/link?code=…` for a **device-code passkey approval** — review the requesting client (name, scopes, fingerprint) and approve with your passkey.
4. **Registers the host** (`claude mcp add-json muhaven …`).
5. **Prints a closing summary** with the daemon PID + endpoint + the stop command.

::: tip No Scoped key yet?
If you press **`n`** (or you're piping/CI with no key), `setup` mints a fresh **ephemeral** key that can read and *propose* — your LLM's buys/sells then return a dashboard deep-link you approve by hand. To upgrade to autonomous later, mint a Scoped session ([M1](/guide/mcp/arm-scoped)) and run the one-paste **`muhaven-broker update --session …`** command from the reveal modal.
:::

## Step 3 — Verify the broker with `doctor`

```bash
muhaven-broker doctor
```

**Expected output** includes:

- the broker **signer address** — `0x…`. This should match the **session signer** shown on your dashboard policy page (proof your Scoped key is the one installed).
- the **JWT scopes** — `mcp.read.*` plus `mcp.propose.*`
- the **keystore location** (OS keychain, or `~/.muhaven/jwt.json` with the file keyring)
- the **broker socket path**

## Step 4 — Restart your host and ask it to read your portfolio

Restart your MCP host so it picks up the newly registered `muhaven` server, then prompt:

```
> What does my muhaven portfolio look like?
```

**Expected:** your LLM makes a MuHaven **read** tool call and returns your aggregate state
(aggregates and encrypted handles — never your cleartext balances).

## Expected result
<ExpectedResult>
Your host lists the <strong>muhaven</strong> MCP server; <code>doctor</code> shows a signer
that matches your dashboard Scoped session; and asking <em>"what's my portfolio?"</em> returns
your aggregate state — no passkey prompt, no transaction (reads are free).
</ExpectedResult>

## Troubleshooting

| Symptom | Fix |
|---|---|
| `muhaven-broker: command not found` | Your npm global bin isn't on PATH. Add npm's global bin dir (find it with `npm bin -g`) to your shell PATH, then reopen the terminal. |
| The pasted key was rejected | `setup` expects the **raw `0x…` 64-hex key** (66 chars), not the `muhaven-broker update …` command. Re-copy with **Copy raw key** in the reveal modal ([M1](/guide/mcp/arm-scoped)). |
| Browser didn't open, or the login link expired | Re-run `muhaven-broker setup`. The login JWT is ~1 hour — re-running re-opens `muhaven.app/link`. |
| `doctor` shows no JWT / an auth error | The daemon is up but not logged in — run `muhaven-broker login` and approve with your passkey. |
| `doctor` signer ≠ your dashboard session | The broker came up on an ephemeral key. Mint a Scoped session ([M1](/guide/mcp/arm-scoped)) and run the modal's `muhaven-broker update --session …` command. |
| Host doesn't list the `muhaven` server / its 25 tools | Restart the host, and check the host's MCP config (`claude mcp list` for Claude Code, or the host's MCP settings). |
| Windows / WSL2 / SSH keyring error | The OS keychain is unavailable on that surface — `export MUHAVEN_KEYRING=file` (a 0600-mode file at `~/.muhaven/jwt.json`), then re-run setup. |

For deeper coverage see the full [MCP install reference](/mcp/install) and
[MCP troubleshooting](/mcp/troubleshooting).

→ Next: [Read your portfolio via MCP](/guide/mcp/reads)
