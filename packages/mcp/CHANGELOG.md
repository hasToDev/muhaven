# Changelog

All notable changes to `@muhaven/mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.4] — 2026-05-17

Adds the one-shot `muhaven-broker setup` subcommand so a fresh install
goes from `npm install -g @muhaven/mcp` straight to a working MCP host
in two commands. Surfaced during the Wave 4 demo-recording prep — the
prior five-line manual ritual (env exports + session-key mint +
background daemon + login) was the longest opaque block in the demo
script.

### Added

- **`muhaven-broker setup` subcommand** — orchestrates env defaulting +
  session-key minting + detached daemon spawn + login in a single
  invocation. Flags:
  - `--foreground` / `-f`: keep the daemon attached to the current
    shell (useful when systemd/launchd will supervise instead of the
    backgrounded child).
  - `--skip-login`: spawn the daemon but defer the device-code flow.
  - `--no-launch-browser`: pass-through to the embedded `login` step.
  - `--broker-endpoint`, `--backend-base-url`, `--dashboard-base-url`:
    same overrides as `login`.

  Env defaults applied (only when the var is unset):
  - `MUHAVEN_BACKEND_URL=https://api.muhaven.app`
  - `MUHAVEN_DASHBOARD_URL=https://muhaven.app`
  - `MUHAVEN_KEYRING=file` (auto-applied on Windows / WSL2 /
    devcontainer / GitHub Codespace / SSH — same heuristic as
    `muhaven-broker doctor`'s environment detector). Native macOS +
    Linux desktop leave the value unset so the OS keychain remains
    the default.

  Idempotent: re-running `setup` against an already-up daemon detects
  the existing JWT and short-circuits to `Login: skipped — JWT already
  in keystore.`. Against a daemon that's up but unauthenticated, it
  skips the spawn and only runs the login step.

  Closing summary surfaces the daemon PID + endpoint + stop command so
  the operator knows how to tear it down.

### Tests

- 170 vitest pass (up from 134 in 0.1.3). Net +36 cases in
  `__tests__/setup.test.ts`:
  - **+10** `applyEnvDefaults` — defaults applied on empty env;
    backend/dashboard preserved when set; KEYRING auto-applied on
    win32/WSL2/SSH/devcontainer/Codespaces; left unset on native
    macOS/Linux desktop; explicit `MUHAVEN_KEYRING=os` preserved on
    Windows; empty-string vars treated as unset.
  - **+2** `mintSessionKey` — 0x-prefixed 32-byte hex shape;
    non-deterministic across calls.
  - **+3** `decideSetupAction` — spawn-and-login / login-only /
    already-ready decision tree.
  - **+6** `parseSetupFlags` — defaults; `--foreground` and `-f`
    aliases; `--skip-login`; `--no-launch-browser` pass-through; value
    flag parsing; unknown-flag rejection.
  - **+3** `waitForBroker` — first-call success; retry-until-success
    with virtual clock; timeout throws with last error in message.
  - **+12** `runSetup` orchestrator — flag-error path returns 2;
    foreground mode short-circuits; spawn_and_login happy path;
    login_only path; already_ready path; `--skip-login`; login-failure
    bubbles exit code + leaves daemon running; wait timeout returns 1;
    `--no-launch-browser` pass-through; value-flag pass-through;
    session key minted vs preserved.

## [0.1.3] — 2026-05-16

Q2 fix bundle from the post-§4 queue closing four findings from §3e⁶
(broker-session-key-required-for-reads, broker-env-divergence,
mcp-serverinfo-version-stale) and unblocking the openclaw-skill ClawScan
fix (the `noExternal: ['@muhaven/mcp']` inline bundle requires this
version on npm before the skill can be republished).

### Added

- **Read-only daemon posture**: the broker daemon now boots WITHOUT
  `MUHAVEN_BROKER_SESSION_KEY`. In that mode the daemon still serves
  `hello` + the JWT verbs (so `muhaven.read.*` tools work end-to-end via
  the standalone `@muhaven/mcp` install), but any `sign_hash` request
  returns the new `session_key_unavailable` broker error so write paths
  fail with a clear remediation message instead of the daemon dying at
  startup. Closes §3e⁶ F-broker-session-key-required-for-reads.
- **`muhaven-broker login --from-daemon` flag**: resolves backend +
  dashboard URLs from the running daemon's `hello.effectiveConfig`
  rather than the login CLI's env. Solves the daemon-vs-CLI env-divergence
  problem when the two processes inherit different shell environments
  (e.g. the daemon was launched by systemd/launchd, the CLI by ssh).
  Mutually exclusive with explicit `--backend-base-url` /
  `--dashboard-base-url`. Closes §3e⁶ F-broker-env-divergence.
- **`muhaven-broker doctor` surfaces the daemon's effective config**
  and read-only-posture status — the operator can verify which backend
  URL is actually in play before driving a login.

### Changed

- **Broker protocol bumped 0.2.0 → 0.3.0** (additive — pre-0.3.0 clients
  remain compatible):
  - `hello.hasSessionKey` (optional `boolean`) — absence implies `true`
    for back-compat.
  - `hello.effectiveConfig` (optional `{ backendBaseUrl, dashboardBaseUrl }`).
  - New `session_key_unavailable` broker error code.
- **`serverInfo.version`** in the MCP server's `initialize` response is
  now build-time injected from `package.json#version` (tsup `define` on
  `__SERVER_VERSION__`) rather than the previously hardcoded `'0.1.0'`
  string in `src/server.ts`. Closes §3e⁶ F-mcp-serverinfo-version-stale.

### Tests

- 134 vitest pass (up from 101 in 0.1.2). Net +33 cases:
  - **+6** `config.test.ts` — `loadBrokerConfig` lazy-validation
    (no key, empty string, valid key, malformed key) + env-driven backend
    + dashboard URL surface.
  - **+5** `daemon-handler.test.ts` — 0.3.0 protocol: `hello` surfaces
    `hasSessionKey` + `effectiveConfig` from options, defaults `true`
    when omitted, reflects `false` when set; `sign_hash` with
    `NullSigner` returns `session_key_unavailable`; re-throws non-Missing
    errors verbatim.
  - **+9** `cli-parse-login-flags.test.ts` — flag parser unit cases
    incl. `--from-daemon` mutual-exclusion guard.
  - **+8** `session-key-required.test.ts` — `signEnvelope` probe of
    `hello.hasSessionKey`; short-circuit returns `SESSION_KEY_REQUIRED`
    for buy + claim with mint-URL pointing at `dashboardBaseUrl`;
    safety-net mapping of inner `session_key_unavailable`;
    probe-cache reuse; concurrent-call coalescing (one hello round-trip
    for N callers); retry-after-rejection (eager cache clear); trailing-slash
    mintUrl strip.
  - **+2** `server-version.test.ts` — runtime fallback returns
    `package.json#version`; matches `manifest.json#version`.
  - **+2** `build-artifacts.test.ts` — hostname-migration guard + new
    `__SERVER_VERSION__` literal grep in bundled dist.
  - **+1** `daemon-lifecycle.test.ts` — read-only-posture boot test
    replaces the prior "exits on missing key" assertion; added
    "exits on a malformed session key" as the second negative-path test.

## [0.1.2] — 2026-05-11

Re-roll of the `0.1.1` workflow-validation cut. `0.1.1` never reached npm:
the tag pointed at the version-bump commit but the workflow at that SHA
lacked two fixes that landed on `agenticwave` after the tag was first cut.
Bumping to `0.1.2` lets the tag reference the latest `agenticwave` HEAD
which contains both fixes; subsequent releases follow the normal flow.

### Fixed

- **NODE_AUTH_TOKEN was overriding the OIDC trusted-publisher exchange in
  `.github/workflows/mcp-publish.yml`** (commit `e373e36`). The
  `actions/setup-node@v4` `registry-url` parameter writes an `.npmrc`
  with `_authToken=${NODE_AUTH_TOKEN}` placeholder; the GitHub Actions
  runner's inherited env had `NODE_AUTH_TOKEN` populated (visible in the
  failing workflow logs as `XXXXX-XXXXX-XXXXX-XXXXX`), so npm tried
  token-based publish first and 404'd because that token has no
  permission on `@muhaven/mcp`. Fix: explicit `env: NODE_AUTH_TOKEN: ''`
  on the publish step forces the `--provenance`-driven OIDC exchange as
  the sole auth method.

- **OIDC claims diagnostic step added pre-publish** (commit `e373e36`).
  Prints `github.repository_owner` / `github.repository` /
  `github.workflow_ref` / `github.event_name` / `github.ref` so that any
  future Trusted Publisher binding mismatch can be diff'd
  character-by-character against the npm-side configuration. Surfaced
  the case-sensitivity gotcha around `repository_owner` that `0.1.1`'s
  three failed attempts triggered.

### Distribution

- Identical bundle bytes to the `0.1.1` artifact except for the embedded
  `0.1.2` version strings in `package.json` + `manifest.json`. No code
  changes to the MCP server or broker daemon. Same `dist/` shape, same
  16 files in the tarball, same `bin/` entry-points.

## [0.1.1] — 2026-05-11

Workflow-validation cut. `0.1.0` shipped via a one-time manual `npm publish
--no-provenance` because npm Trusted Publisher could not be configured against
a non-existent package; this release exercises the `mcp-publish.yml` workflow
end-to-end on the muhaven.app hosts so subsequent releases carry full Sigstore
provenance attestations and `npm view dist.signatures` populates.

### Fixed

- Re-runs the publish path through `.github/workflows/mcp-publish.yml`
  (Workstream D) on the now-configured Trusted Publisher binding for
  `@muhaven/mcp`. Validates the full OIDC → cosign sign → `npm publish
  --provenance` → post-publish shasum verify chain that `0.1.0` skipped.
- No code change relative to `0.1.0`. Bundle bytes identical except for the
  embedded `0.1.1` version string in `package.json` + `manifest.json`. The
  `0.1.0` "Provenance" badge gap (visible on the npmjs.com sidebar) closes
  with this release.

### Distribution

- First release where `npm view @muhaven/mcp@0.1.1 dist.signatures` returns a
  populated array, `dist.attestations.url` resolves to a GitHub-hosted
  attestation, and the npmjs.com sidebar shows the "Provenance" badge linked
  to the workflow run.



First publishable cut. All publish-readiness security must-fixes (H-1 / H-2 /
H-3 from `MCP_PUBLISH_READINESS.md` §2) and package-hygiene work landed on
`agenticwave` ahead of the npm publish ceremony. The actual `npm publish` is
gated on the operator-side `AGENTIC_TEST_PLAN.md` walkthroughs completing.

### Added — Tools (22)

- `muhaven.read.*` (7): `portfolio` · `yields` · `distribution` · `tokens` ·
  `audit` · `protection_coverage` · `kyc_attestation`
- `muhaven.position.*` (4): `buy` · `sell` · `claim` · `rebalance`
- `muhaven.policy.*` (4): `set_tier` · `pause` · `audit_export` ·
  `session_key_status`
- `muhaven.issuer.*` (5): `distribute_yield` · `kyc_add` · `kyc_remove` ·
  `unpause_token` · `audit_query`
- `muhaven.governance.*` (2): `propose` · `cast_vote` (frontend runner
  deferred to Wave 5)

### Added — Infrastructure

- MCPB-format `manifest.json` (manifest_version 0.2) declaring four
  `user_config` entries (`backend_url`, `dashboard_url`, `broker_endpoint`,
  `read_only`) so MCPB hosts (Claude Desktop, Cursor, future MCPB store) can
  render install dialogs without the operator hand-editing config files.
- Companion `muhaven-broker` daemon over Unix socket (POSIX) / named pipe
  (Windows). Holds the session-key private half; the MCP server never sees
  the key, only signed UserOps it relays back to the LLM host.
- OAuth 2.0 Device Authorization Grant flow with scoped JWTs
  (`mcp.read.*` + `mcp.propose.*`). Replaces paste-JWT UX; mitigates the
  R-7 lethal-trifecta concern (env-block credential storage).
- Tool-description SHA-256 hash pinning (`tool-hashes.json` + the
  `verify-tool-hashes` script). Server startup re-verifies and exits with
  code `70` (`EX_CONFIG`) on drift; CI gate via the same script with
  `--check`.
- `@napi-rs/keyring` integration for the broker's JWT keystore (Windows
  DPAPI / macOS Security framework / Linux Secret Service via D-Bus) with
  file-backed fallback (`MUHAVEN_KEYRING=file`) for WSL2 / devcontainer /
  SSH-remote where Secret Service is absent.

### Security

- Broker isolation: no TCP transport; POSIX socket created at mode `0700`
  with file mode `0600`; Windows named-pipe ACL inherits user.
- STDIO-only MCP transport; `mcp-remote` (CVE-2025-6514) banned in README.
- Position / policy / issuer / governance tools return unsigned UserOps +
  broker signatures; **never** auto-submit to a bundler.
- Tool-description hash pinning makes MCPoison-style descriptor-tampering
  attacks fail-closed (server exits before the LLM sees the drifted text).
- Workstream A security must-fixes (commit `44bd8b2`):
  - **H-1**: sourcemaps stripped from publish bundle (`tsup.config.ts`
    gates on `MUHAVEN_DEV_BUILD=1`). Removes `.js.map` / `.cjs.map` /
    `.d.ts.map` containing absolute developer paths from npm tarballs.
  - **H-2**: `package.json` declares `publishConfig.{access:public,
    registry:https://registry.npmjs.org/, provenance:true}` so a manual
    `npm publish` from a recovery laptop can't silently publish privately
    or without provenance.
  - **H-3**: keystore probe round-trip-parses the OS-keychain value via
    `parseRecord`. Malformed JSON / wrong-shape JSON / Secret-Service-down
    each fall back to `FileKeystore` with a discriminated `fallbackReason`.
    `muhaven-broker doctor` performs a non-destructive sentinel round-trip.
- Workstream B publint hardening (commit `a01116e`): `exports` map fixed
  to per-condition `import.types` + `require.types` so TypeScript
  resolution is honest on both ESM and CJS consumers.

### Tests

- 100 vitest cases (`__tests__/`):
  - `protocol` (13) — IPC frame codec / JSON-RPC envelope shape
  - `backend-client` (5) — REST-call shape + error mapping
  - `descriptions` (7) — descriptor surface drift detection
  - `jwt-source` (5) — broker-cached JWT lifecycle
  - `daemon-handler` (7) — IPC method dispatch
  - `registry` (8) — tool registration invariants
  - `mcp-redteam` (46) — adversarial inputs against `buildMcpServer` +
    `InMemoryTransport`
  - `daemon-lifecycle` (3) — bin shim survives past `runMcpStdioCli`
    resolution (regression guard against the 2026-05-10 ship-blocker
    bugs in `bin/*.cjs`)
  - `keystore` (5) — H-3 OS-keychain probe regression coverage
  - `build-artifacts` (1) — H-1 publish-bundle map-free assertion
- Three-way subset gate (`scripts/verify-tool-hashes.ts`) enforces
  consistency between `src/index.ts` registry, `manifest.json#tools`,
  and `tool-hashes.json`.

### Known limitations (documented residuals — see SECURITY.md to land in
Workstream H)

- The MCP package is published WITHOUT a domain-bound icon — manifest's
  `icon` field was deliberately removed in Workstream B because no asset
  ships yet. MCPB host install dialogs render the default placeholder.
  Real amber-gradient icon ships in a Wave 5 follow-up.
- Listed JSON schemas don't reflect per-tool field hints (L-1 backlog).
- `BackendClient` errors echo URL pathnames (L-2; recommend host-side
  scrubbing).

### Distribution

- Published via npm OIDC + Sigstore provenance attestations from the
  `.github/workflows/mcp-publish.yml` workflow (tag-driven on
  `mcp-v*`; manual `workflow_dispatch` available for recovery).
- Tarball + `.sigstore` bundle uploaded as workflow artifacts and as
  files on the `mcp-v0.1.0` GitHub Release.
- Verify locally with:
  ```
  cosign verify-blob \
    --bundle muhaven-mcp-0.1.0.tgz.sigstore \
    --certificate-identity-regexp "^https://github\.com/hasToDev/muhaven/" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
    muhaven-mcp-0.1.0.tgz
  ```

[Unreleased]: https://github.com/hasToDev/muhaven/compare/mcp-v0.1.3...HEAD
[0.1.3]: https://github.com/hasToDev/muhaven/releases/tag/mcp-v0.1.3
[0.1.2]: https://github.com/hasToDev/muhaven/releases/tag/mcp-v0.1.2
[0.1.1]: https://github.com/hasToDev/muhaven/releases/tag/mcp-v0.1.1
[0.1.0]: https://github.com/hasToDev/muhaven/releases/tag/mcp-v0.1.0
