# Changelog

All notable changes to `@muhaven/mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/hasToDev/muhaven/compare/mcp-v0.1.2...HEAD
[0.1.2]: https://github.com/hasToDev/muhaven/releases/tag/mcp-v0.1.2
[0.1.1]: https://github.com/hasToDev/muhaven/releases/tag/mcp-v0.1.1
[0.1.0]: https://github.com/hasToDev/muhaven/releases/tag/mcp-v0.1.0
