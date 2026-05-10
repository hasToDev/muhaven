# `@muhaven/mcp` — MCP server for MuHaven RWA portfolios

Confidential RWA portfolio management on Fhenix CoFHE, exposed as a Model
Context Protocol server installable in Claude Desktop / Cursor / Claude Code.

## What it does

22 tools across five groups (P3 + P7 + P11):

| Group | Tools | Description |
|---|---|---|
| `muhaven.read.*` | `portfolio` · `yields` · `distribution` · `tokens` · `audit` · `protection_coverage` · `kyc_attestation` | Read your encrypted-balance portfolio, yield history, audit log, and P11 governance/KYC state |
| `muhaven.position.*` | `buy` · `sell` · `claim` · `rebalance` | **Propose** trades — returns unsigned UserOps + broker signature; never auto-submits |
| `muhaven.policy.*` | `set_tier` · `pause` · `audit_export` · `session_key_status` | Manage the tiered-autonomy state machine |
| `muhaven.issuer.*` | `distribute_yield` · `kyc_add` · `kyc_remove` · `unpause_token` · `audit_query` | Issuer-side: distribute yield, manage KYC whitelist, NAV-set+unpause, query own audit trail |
| `muhaven.governance.*` | `propose` · `cast_vote` | P11 encrypted-governance ceremony (cast-vote frontend runner deferred to Wave 5) |

`MUHAVEN_READ_ONLY=true` exposes only the 7 `muhaven.read.*` tools.

## Architecture (one paragraph)

The MCP server runs as an MCPB STDIO subprocess of the host LLM (Claude
Desktop, Cursor, Claude Code). It speaks HTTPS to the MuHaven backend at
`https://nagreg.hasto.dev` and IPC to a long-running sibling daemon
called `muhaven-broker`. The broker holds two secrets — your ZeroDev
session-key private half (for signing UserOps) and your scoped JWT (for
authenticating to the backend) — both in your OS keychain. The broker
NEVER speaks TCP and NEVER reaches out to the network. It exposes one
signing primitive over a Unix socket (POSIX) or named pipe (Windows).
This split — network-facing MCP server / signing-only broker — is the
**lethal-trifecta** mitigation: an attacker who compromises the LLM
process cannot exfiltrate your key without also compromising a separate
process running under your user.

The `muhaven-broker login` ceremony uses the OAuth 2.0 Device
Authorization Grant (RFC 8628) — same shape as `gh auth login --web`,
`wrangler login`, `gcloud auth login`. You never paste a JWT.

## Install (development)

```bash
# In the muhaven monorepo, from repo root
pnpm install
pnpm --filter @muhaven/mcp build
```

The `bin/` shims will be invokable as `muhaven-mcp` and `muhaven-broker`
once the package is linked.

## Setup (end-user, post-MCPB-publish)

1. **Install the MCPB package** in your host (Claude Desktop / Cursor / Claude Code).
2. **Provision a session key.** This is the private half the broker holds for signing UserOps. The dashboard-side mint UI is a Wave 5 deliverable — until then, generate one yourself:
   ```bash
   node -e "console.log('0x' + require('crypto').randomBytes(32).toString('hex'))"
   ```
   The corresponding kernel session key install on-chain runs through the dashboard `/agent/policy/transition` flow (one-time per tier). For read-only smokes you can skip the install — the broker only needs the private half to start.
3. **Start the broker daemon.** Set `MUHAVEN_BROKER_SESSION_KEY=0x…` and run:
   ```bash
   muhaven-broker
   ```
   Recipes for systemd / launchd / Windows Service in `docs/runbook.md` (TODO).
4. **Authenticate via device-code flow:**
   ```bash
   muhaven-broker login
   ```
   The broker prints a URL like `https://muhaven.hasto.dev/link?code=ABCD-1234` and (when not run with `--no-launch-browser`) opens it. Sign in with your passkey on the dashboard, verify the device fingerprint shown on the `/link` page, click **Authorize**. The CLI exits with success when the JWT lands in your keystore.
5. **Use any MCP tool** from your host LLM. First call may take a moment as the broker fetches the JWT from the keystore.

> **Windows / WSL2 / devcontainer / SSH-remote operators:** export `MUHAVEN_KEYRING=file` to skip the OS-keychain probe and use the file-backed keystore at `~/.muhaven/jwt.json`. The keychain backend depends on `@napi-rs/keyring` which needs platform-specific build prerequisites; the file fallback works everywhere.

## Hardening invariants (`THREAT_MODEL_P0.md` aligned)

- **Transport is STDIO + Unix-socket only.** The MCP server's `StdioServerTransport` is the only transport mounted; the broker's IPC is a Unix socket on POSIX (parent dir mode `0700`, socket file mode `0600`) or a per-user named pipe on Windows. **Never bind TCP.**
- **`mcp-remote` is banned.** CVE-2025-6514 disclosed an arbitrary-command-execution path through that proxy. Do not use it; do not set `MUHAVEN_BACKEND_URL` to anything that wraps it.
- **`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`** is recommended in your shell rc when running Claude Code locally — it prevents inherited env vars from leaking into the MCP subprocess. The MCP package's `MUHAVEN_*` env vars are read at boot, but adopting the scrub habit limits collateral exposure.
- **Tool descriptions are pinned** at build time in `tool-hashes.json`. The server exits with code 70 (`EX_CONFIG`) on startup if the live descriptors don't match the pinned hashes — defends against tool-description-poisoning patches per the mcp-context-protector pattern (post-MCPoison, March 2026).
- **Position tools never auto-submit.** They return an unsigned UserOp envelope plus a broker signature. The host LLM is expected to present this to the user for explicit confirmation before bundler submission. The MCP server does not speak to any bundler.

## Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `MUHAVEN_BACKEND_URL` | no | `https://nagreg.hasto.dev` | Backend host. Use staging URL for development. |
| `MUHAVEN_DASHBOARD_URL` | no | `https://muhaven.hasto.dev` | Dashboard origin used for the `/link` URL. |
| `MUHAVEN_BROKER_ENDPOINT` | no | `~/.muhaven/broker.sock` (POSIX) / `\\.\pipe\muhaven-broker-<user>` (Windows) | IPC path. Set if running multiple isolated brokers. |
| `MUHAVEN_BROKER_SESSION_KEY` | **yes** (broker) | — | 0x-prefixed 32-byte hex; the session-key private half. |
| `MUHAVEN_READ_ONLY` | no | `false` | When `true`, only `muhaven.read.*` tools are registered. |
| `MUHAVEN_KEYRING` | no | auto | Set to `file` to force the file-backed keystore (required on WSL2 / devcontainer / SSH-remote). |
| `MUHAVEN_REQUEST_TIMEOUT_MS` | no | `15000` | Backend HTTP timeout. |
| `MUHAVEN_BROKER_TIMEOUT_MS` | no | `5000` | Broker IPC timeout. |
| `MUHAVEN_JWT_CACHE_TTL_SEC` | no | `30` | In-process JWT cache TTL. |
| `MUHAVEN_BROKER_MAX_BYTES` | no | `65536` | Per-request payload cap on the broker IPC. |

The MCPB `manifest.json` declares the user-facing subset (`backend_url`, `dashboard_url`, `broker_endpoint`, `read_only`); the host's secret manager handles the values.

## CLI subcommands (`muhaven-broker`)

| Command | Effect |
|---|---|
| (none) | Run the daemon (production mode). |
| `muhaven-broker login [--no-launch-browser]` | Run the device-code ceremony; on success store the JWT in the keystore. |
| `muhaven-broker logout` | Clear the JWT from the keystore. |
| `muhaven-broker doctor` | Print environment + keystore + reachability report. |

## Threat model in 30 seconds

Per `development/DEV_WAVE_4/THREAT_MODEL_P0.md`:

| Risk | Control |
|---|---|
| **R-1** Prompt injection escalating into a tx | Position tools return *unsigned* UserOps; host MUST present to user for explicit passkey confirmation. |
| **R-2** Hallucinated tool call | Strict-enum tool registry + `additionalProperties: false` Zod schemas. |
| **R-3** Replay of confirmation tokens | Single-use server-side nonced tokens via existing P1 confirm-token-service. |
| **R-6** ZeroDev session-key escape | Session key lives in broker keystore (OS keychain) — never in the LLM-process env. |
| **R-7** MCP env-block exfiltration | MCPB `sensitive: true` for secrets → OS keychain; broker isolation; no plaintext disk. |
| **R-8** FHE ACL bypass | Backend enforces every read; MCP server never decrypts FHE handles. |

## License

MIT

## Status: P3 hackathon ship

This is the Wave 4 Phase P3 ship per `development/DEV_WAVE_4/PROGRESS.md`. The publish-to-npm-with-OIDC story lands as a separate operator task; today the package is workspace-only.
