---
title: '@muhaven/mcp — broker daemon'
description: What the broker actually does, and why it's a separate process.
---

# The broker daemon

`muhaven-broker` is a long-lived per-user daemon that holds two things you don't want in your LLM's process memory:

1. **Your scoped JWT** (`mcp.read.*` + `mcp.propose.*` claims) — issued at login, stored in OS keychain.
2. **Your ZeroDev session-key private half** — used to sign UserOp authorizations.

The MCP server (`muhaven-mcp`) talks to the broker over a **Unix socket** (POSIX) or **named pipe** (Windows). The broker exposes one signing primitive (`sign_hash`) and one JWT-store primitive (`store_jwt` / `get_jwt` / `clear_jwt`). It never speaks TCP.

## Why a separate process?

Three threat-model wins:

1. **LLM jailbreak ≠ key theft.** A compromised LLM process — even one with arbitrary code execution via a CurXecute-style RCE — cannot read your keys from the broker's memory. To exfil, the attacker also needs to compromise a separate process running under your user with no inbound network surface.
2. **No env-block credentials.** Putting a session key in `claude_desktop_config.json` env block is a known exfiltration class (R-7 in the threat model). The broker pattern keeps the key in OS keychain (or a 0600-mode file) instead.
3. **POSIX file-perm ACLs are simple and reviewable.** Parent dir at `0700`, socket at `0600`. No TLS handshake, no auth tokens — the OS handles authorization.

## Lifecycle

```
$ muhaven-broker
  [12:01] broker: keystore  = ~/Library/Keychains/login.keychain (macOS)
  [12:01] broker: socket    = /tmp/muhaven-broker.sock
  [12:01] broker: backend   = https://api.muhaven.app
  [12:01] broker: listening
```

The broker stays running. It survives terminal close (it's not tied to a TTY), but it's not a system service — when you reboot, you start it again.

To stop: **Ctrl-C in the broker terminal**, or send SIGTERM with `kill <pid>` from anywhere.

## Authentication: the device-code flow

When you run `muhaven-broker login`:

1. Broker hits `POST /api/v1/auth/device/code` → receives `{ device_code, user_code, verification_uri, expires_in, interval }`.
2. Broker prints `Open https://muhaven.app/link?code=ABCD-1234` and opens your default browser.
3. The `/link` Vue page **fetches the requester metadata BEFORE you authorize**. You see: "A device named 'muhaven-broker' on 'your-machine' is requesting `mcp.read.*` + `mcp.propose.*` scopes."
4. You authorize with your passkey (the dashboard JWT auth path).
5. Broker polls `POST /api/v1/auth/device/token` every `interval` seconds.
6. On approval, backend returns a scoped JWT. Broker stores it in OS keychain.

The pre-authorization fetch of the requester metadata is the load-bearing **phishing-resistance** control. A phishing site at `muhaven-link.com` cannot complete the ceremony because the `verification_uri` is hard-coded to `muhaven.app` and the WebAuthn passkey is RP-ID-pinned to `muhaven.app`.

## Storage: OS keychain (with file fallback)

Default backend (`@napi-rs/keyring`):

| Platform | Backed by |
|---|---|
| macOS | Keychain Access (login keychain) |
| Linux | Secret Service (libsecret + GNOME Keyring / KWallet) |
| Windows | Credential Manager |

If the keychain isn't available (WSL2, devcontainer, SSH-remote shell), set `MUHAVEN_KEYRING=file` to use a 0600-mode file at `~/.muhaven/jwt.json`. The file is:

- Created with `umask(0077)` so only the owner can read it.
- Parent directory created at `0700`.
- Cleared on `muhaven-broker logout` (overwritten with `{}` and then removed).

## The IPC protocol

v0.2.0 of the broker protocol uses **newline-delimited JSON** over the socket:

```
client → broker:  {"verb":"hello","client":"muhaven-mcp","version":"0.1.2"}\n
broker → client:  {"ok":true,"broker_version":"0.1.2","caps":["sign_hash","jwt"]}\n

client → broker:  {"verb":"sign_hash","hash":"0xabc...","domain":"muhaven.placeholder.intent.v0:..."}\n
broker → client:  {"ok":true,"signature":"0xdef..."}\n
```

**Defensive properties:**

- Single-shot per connection — the broker doesn't pipeline. After response, it disconnects.
- Size cap on inbound messages (16 KB).
- Malformed JSON returns a structured `{"ok":false,"reason":"PARSE_ERROR"}` instead of crashing.
- The connecting peer is verified via POSIX peer credentials (`SO_PEERCRED` on Linux) — only the broker-owning UID can connect.

## `muhaven-broker` subcommands

```bash
muhaven-broker                       # start the broker (no subcommand = daemon mode)
muhaven-broker login                 # device-code flow
muhaven-broker logout                # clear JWT from keystore
muhaven-broker doctor                # print environment + keystore + reachability report
muhaven-broker --help                # show usage
```

To stop a running daemon: Ctrl-C in its terminal, or `kill <pid>` from anywhere.

::: tip Run `muhaven-broker doctor` first
For any "auth broken" issue, `doctor` is the first thing to run. It prints:
- Broker version + socket path
- Keystore backend (keychain / file) + location
- JWT presence, scopes, expiry
- Backend URL + last reachable timestamp
:::

## Why the placeholder intent domain?

The broker's `sign_hash` verb signs **only** hashes prefixed with `muhaven.placeholder.intent.v0:`. The MCP server constructs these hashes from the propose-tool payload; the placeholder domain ensures a broker signature can **never** be replayed as a real EIP-712 hash or a real ZeroDev UserOp hash on-chain.

This means: a leaked broker signature isn't a "drain my account" key. It's only useful inside the MCP propose-then-commit ceremony, and only for one specific propose envelope.

The signature pattern is intentionally analogous to the WebAuthn challenge-binding pattern — single-use, scoped to one event, deterministic.

## Where next

- [Install](/mcp/install) — get the broker running.
- [Troubleshooting](/mcp/troubleshooting) — broker-specific issues.
- [Threat model in plain language](/policy/threats) — why the broker exists.
