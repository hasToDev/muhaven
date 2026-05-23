# Changelog

All notable changes to `@muhaven/mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.8] — 2026-05-23

### Added

- **`pathDBundlerTrace` inline in the `muhaven.position.buy` echo on
  fallback.** Every Path D attempt now buffers its bundler RPC
  round-trips in a 20-event ring on the `BundlerClient`; on any
  fallback return the handler drains the ring and inlines it into
  the echo:

      pathDBundlerTrace: [
        {
          method: 'eth_call',
          id: 12,
          requestBody: '{"jsonrpc":"2.0","id":12,"method":"eth_call",...}',
          responseStatus: 200,
          responseBody: '{"jsonrpc":"2.0","id":12,"result":"0x..."}',
          elapsedMs: 87,
        },
        {
          method: 'zd_sponsorUserOperation',
          id: 14,
          requestBody: '{"jsonrpc":"2.0","method":"zd_sponsorUserOperation","params":[...]}',
          responseStatus: 400,
          responseBody: '{"error":"AA23 reverted ..."}',
          error: { code: 'http_error', message: '...' },
          elapsedMs: 412,
        },
      ]

  Bodies truncated at 2KB. The LLM (and the operator reading the
  tool result) sees the EXACT wire payload that the bundler /
  paymaster rejected — no need for curl repro or Claude Code
  subprocess log digging. Confirmed 2026-05-23 that Claude Code's
  MCP client only captures subprocess stderr at handshake (not
  during tool calls), so the 0.2.7 stderr-verbose path never reached
  the LLM context during the smoke iterations.

  Ring buffer is always-on (no env-gate, ~80KB worst-case per
  BundlerClient instance) so the next gate is self-diagnosing
  immediately without a second `npm i -g` cycle.

  `BundlerClient.drainTrace()` returns + clears the ring; called at
  the start of `attemptPathD` (clear stale) and again right before
  the fallback echo (collect + inline).

### Tests

- bundler-client.test.ts: new ring-buffer behaviour cases (drain
  returns a copy; drain clears; ring is bounded at 20; populates on
  success + http_error + timeout + rpc_error).

## [0.2.7] — 2026-05-23

### Added

- **Startup banner (always on).** `runMcpStdioCli` writes one stderr
  line at boot with the running version + verbose mode:

      [muhaven-mcp] starting @muhaven/mcp@0.2.7 (verbose=off)

  Multiple smoke iterations have been ambiguous about whether
  `npm i -g @muhaven/mcp@<v>` actually updated the global binary
  picked up by Claude Code (the subprocess only re-spawns on FULL
  Claude Code restart, not `/mcp reconnect`). One stderr line at boot
  makes the version mismatch impossible to miss.

- **Verbose paymaster/bundler logging (`MUHAVEN_MCP_VERBOSE=1`).**
  Gated env var that emits two stderr lines per bundler RPC:

      [muhaven-mcp] [bundler→] zd_sponsorUserOperation id=N body={...}
      [muhaven-mcp] [bundler←] zd_sponsorUserOperation id=N resp={...}

  Bodies truncated at 2KB; covers happy-path, http_error, timeout,
  non-JSON, network failures. Add `"MUHAVEN_MCP_VERBOSE": "1"` to the
  `.mcp.json` env block when triaging a `pathDFallbackReason` —
  removes the need for curl repro entirely.

### Fixed

- **Stale `pm_sponsorUserOperation` label in the
  `paymaster_rejected` fallback message** (0.2.4 leftover). The
  actual method call has been `zd_sponsorUserOperation` since 0.2.4,
  but the error message label still said `pm_*`. No functional
  impact — just a confusing log string when the gate fires.

## [0.2.6] — 2026-05-23

### Fixed

- **`PLACEHOLDER_SIGNATURE` uses exact `@zerodev/sdk::DUMMY_ECDSA_SIG`
  bytes** — NOT random `0xfe`-filled high-entropy bytes (the 0.2.5
  regression). Per `@zerodev/permissions::toPermissionValidator.js`,
  the canonical stub signature for paymaster simulation is:

      concat(["0xff", signer.getDummySignature()])
            ↓                ↓
      "use root permission"  DUMMY_ECDSA_SIG = "0xfffffff...7aa...aaa...1c"

  The DUMMY_ECDSA_SIG is a CRAFTED 65-byte pattern (r is high-end of
  secp256k1's field, s is `7aa...aaa`, v is `0x1c`) that the
  PermissionValidator's `validateUserOp` simulation path recognizes
  as a stub and skips real ecrecover. 0.2.5 had the right length (66
  bytes) and the right `0xff` prefix, but filled the trailing 65
  bytes with random `0xfe` — the validator ecrecovers them as if
  real, gets a garbage address that doesn't match the bound session-
  key, reverts with `AA23` → paymaster returns rpc_error → MCP maps
  to `paymaster_rejected`.

  The new `pathDFallbackDetail` echo (0.2.5) made this trivially
  diagnosable on the very next smoke iteration — the surfaced
  message was `zd_sponsorUserOperation → HTTP 400 → AA23 reverted`
  which pinned the validator-revert layer.

  Verified 2026-05-23 against `@zerodev/sdk@5.5.10`'s
  `_cjs/constants.js::DUMMY_ECDSA_SIG` and
  `@zerodev/permissions/_cjs/toPermissionValidator.js::getStubSignature`.

  Regression tests pin: byte length (66), `0xff` prefix, trailing
  65-byte byte-for-byte match against DUMMY_ECDSA_SIG, v=0x1c,
  s-component magic pattern (rejecting the 0.2.5 `0xfe`-filled
  shape).

## [0.2.5] — 2026-05-23

### Fixed

- **`PLACEHOLDER_SIGNATURE` size 86 bytes → 66 bytes** to match the
  real Kernel v3.1 PermissionValidator signature shape that
  `buildKernelSessionKeySignature` produces:

      byte 0       — 0xff (PermissionValidator "use root permission" sentinel)
      bytes 1..65  — 65-byte ECDSA
      = 66 bytes total

  Pre-0.2.5 the placeholder was 86 bytes — the OLD enable-mode shape
  (1 byte prefix + 20 bytes validator + 65 bytes ECDSA). The paymaster
  simulated the validator with the wrong-length signature, the
  validator reverted with `AA23 reverted`, and
  `zd_sponsorUserOperation` returned rpc_error → MCP mapped to
  `paymaster_rejected`. This is the load-bearing piece that 0.2.4 did
  NOT close.

### Added

- **`pathDFallbackDetail` in the `muhaven.position.buy` echo.** Every
  Path D fallback (`bundler_setup_failed`, `paymaster_rejected`,
  `encrypt_shares_server_error`, etc.) now carries the underlying
  error message in addition to the structured reason code. Pre-0.2.5
  the message was dropped → every new gate required curl repro to
  find the actual error class (cost ~2 publish cycles during the
  2026-05-23 smoke). Future fallback iterations are self-diagnosing.
  Untrusted-network input (bundler RPC error messages) is sanitized
  server-side before crossing into the echo (existing
  `sanitizeRpcMessageForLlmContext` boundary).

### Changed

- **`DEFAULT_REQUEST_TIMEOUT_MS` 15s → 75s.** The cold-start FHE
  encrypt at `/api/v1/agent/path-d/encrypt-shares` costs ~25s on
  first call after fhe-worker container boot (CoFHE verifier-
  signature handshake). The 15s default cut the MCP-side fetch
  before the backend's reply arrived → spurious
  `encrypt_shares_server_error`. Operators on warm setups can
  tighten via `MUHAVEN_REQUEST_TIMEOUT_MS`. Subsequent encrypts
  after warm-up are sub-second; the 75s ceiling is defensive
  headroom, not steady-state latency.

## [0.2.4] — 2026-05-23

### Fixed

- **Paymaster RPC method + param shape**:
  `pm_sponsorUserOperation` → `zd_sponsorUserOperation`. ZeroDev v3
  endpoints route paymaster RPCs through Alchemy infrastructure, which
  exposes only ERC-7677 (`pm_getPaymasterStubData` / `pm_getPaymasterData`)
  and ZeroDev-prefixed (`zd_sponsorUserOperation`) — the legacy
  `pm_sponsorUserOperation` returns `"Unsupported method"` from
  Alchemy. The MCP server's `attemptPathD` failed at
  `pathDFallbackReason: paymaster_rejected` on every Path D autonomous
  buy. Fix: switch method name + change request shape from positional
  `[userOp, entryPoint]` to wrapped
  `[{chainId, userOp, entryPointAddress, shouldOverrideFee, shouldConsume}]`.
  Matches `@zerodev/sdk@5.5.10`'s `paymaster/sponsorUserOperation.js`
  byte-for-byte. Verified 2026-05-23 via direct curl reproduction
  against the prod bundler URL (bare → "Unsupported method"; correct
  shape → simulation result with AA23 from synthetic UserOp, proving
  the method works).

  `sponsorUserOp` now requires `expectedChainId` in `BundlerClientOptions`
  (throws `BundlerClientError(config)` when missing) — the chainId is
  part of the request envelope. Defaults conservative placeholder gas
  limits on the userOp when the caller omits them (ZeroDev's Zod
  validator requires the gas fields in the request even though
  simulation recomputes them).

  Added 3 regression tests pinning the new method name, the wrapped
  envelope, the gas-default behaviour + a `config`-error case when
  expectedChainId is missing.

## [0.2.3] — 2026-05-23

### Fixed

- **`BundlerClient` now sends an `Origin` header on every RPC.** ZeroDev
  bundler URLs gate access via an IP+domain allowlist; browser requests
  from `https://muhaven.app` pass because the project's allowlist
  accepts that domain, but Node `fetch` (the MCP server's transport)
  sends no `Origin` by default and so hit a `403 "Neither IP nor domain
  is on the allowlist"` on every `eth_call` / `eth_gasPrice`. The MCP
  server then surfaced this as `pathDFallbackReason:
  bundler_setup_failed` and degraded to Path C. Fix: stamp `Origin:
  <MUHAVEN_DASHBOARD_URL>` on every bundler RPC (defaults to
  `https://muhaven.app`, threaded through from
  `buildMcpServer({ dashboardBaseUrl })`). Mirrors how ethers.js + viem
  stamp default Origins against EVM RPC providers; surfaces a single
  knob (`MUHAVEN_DASHBOARD_URL`) for operators on a custom domain.
  Diagnosed 2026-05-23 via direct curl reproduction (bare → 403; with
  `Origin: https://muhaven.app` → `result: 0x66eee`).

  Added 3 regression tests pinning the contract (Origin sent when set;
  omitted when undefined; omitted when explicitly empty for test
  injection).

## [0.2.2] — 2026-05-23

### Fixed

- **`tools/list.inputSchema` now exposes the per-field shape, not a
  bare `{type:'object', additionalProperties:false}` placeholder.**
  The 0.2.1 (and earlier) `toJsonInputSchema` was a stub: it returned
  the object envelope with `additionalProperties:false` but no
  `properties` block. JSON-Schema-compliant MCP hosts (Claude Code's
  tool-call validator) interpret that combination as "no properties
  allowed" and silently strip every argument before dispatch — every
  call landed at the server as `{}`. Surfaced 2026-05-23 by an
  operator-side `Buy TBILL1 $1` smoke. Fix: wire `zod-to-json-schema`
  (`target: 'jsonSchema7'`, `$refStrategy: 'none'`,
  `removeAdditionalStrategy: 'strict'`) so the real per-field shape
  reaches the host. Drops the top-level `$schema` URL (host noise).
  Added 14 unit + 48 registry-wide regression cases pinning the
  contract per tool, plus a recursive nested-strict walker that fails
  if a future contributor adds a nested `z.object(...)` without
  `.strict()` (Security Engineer MED, absorbed inline).

### Dependencies

- **Added `zod-to-json-schema@^3.24.0`** as a runtime dep (~30KB, zero
  transitive deps). Required by the inputSchema fix above; previously
  the converter was a placeholder stub per the original commit's note
  to "avoid runtime dep for hackathon scope."
- **Bumped `zod` dep range from `^3.24.0` to `^3.25.0`** to match
  `@modelcontextprotocol/sdk@^1.0.4`'s peer-dep declaration
  (`zod: ^3.25 || ^4.0`). The installed tree already resolves to
  3.25.x so prod runtime is unchanged, but the declared range avoids
  a peer-dep warning for consumers running `npm i @muhaven/mcp` with
  an older zod hoisted in their tree (Code Reviewer HIGH, absorbed
  inline).

### Notes

- **`tool-hashes.json` does NOT need regenerating for 0.2.2.** The
  hashed surface is the tool descriptor (name + description +
  sensitive flag, see `descriptions.ts::hashToolDescriptor`); the
  JSON-Schema export is downstream of that and not part of the hash.
  `pnpm verify-tool-hashes -- --check` continues to pass against the
  existing pin from 0.2.0.

### Added — Wave 5 Path D Slice 1 (in flight)

- **Broker protocol verb `get_active_session_id`** (additive over 0.4.0).
  Narrow "which session is live?" probe — returns the sessionId of the
  single non-expired snapshot bound to the broker's loaded signer, or
  null on zero / 2+ matches. Backs the MCP server's bootstrap of Path
  D's broker-side signing path before Slice 2's backend-mirror
  `agent_scoped_sessions` table lands. Intentionally narrower than
  `list()` so RD-3 (no IPC enumeration) stays honoured.
- **`BrokerClient.preflight()` + semver gate (Backend Architect H-2).**
  Detects stale 0.3.x daemons before any sign_userop call, surfacing
  `version_too_old` / `session_key_unavailable` / `broker_unreachable`
  with structured remediation hints instead of an opaque
  `unsupported_type`.
- **`BundlerClient` (NEW, `src/clients/bundler-client.ts`).** ERC-4337
  v0.7 JSON-RPC client surface — `sendUserOp` + `getReceipt` +
  `waitForReceipt` + `assertChainId`. Lives MCP-server-side (network
  egress), not in the broker (R-1 zero-egress invariant preserved).
  Configured via new `MUHAVEN_BUNDLER_URL` + `MUHAVEN_CHAIN_ID` env
  vars (manifest.json user_config block extended). The UserOp BUILD +
  SIGN path remains DEFERRED to a later release (FHE encrypt + kernel-
  execute encode have unresolved design points); the bundler-client
  surface ships now with full test coverage.
- **`positionBuy` Path D probe.** When BOTH bundler and broker are
  configured, the handler runs a preflight chain
  (preflight → getActiveSessionId → getPolicySnapshot → selector-cap
  match → shares cap) BEFORE building the Path C deep-link. Every gate
  failure surfaces as a structured non-retryable
  `pathDFallbackReason` in the echo while still returning a valid
  Path C URL — single affordance for the user, full structured
  observability for the LLM. The "all gates pass" terminal state
  returns `path_d_userop_build_pending` until the UserOp build path
  lands.
- **`/agent/policy/state` extension** (backend): top-level
  `accountAddress` field (= JWT subject = kernel smart-account
  address). Backward-compatible; older callers ignore the new field.
  Lays foundation for the Commit 3.5 UserOp builder's kernel-address
  lookup without needing a separate /me endpoint.

### Internal — Wave 5 Path D Slice 1

- `IPolicyStore.activeSessionId(activeSignerAddress, nowSec)` method —
  enumerates daemon-internal snapshots, returns the unique active
  sessionId or null. File-backed + memory implementations both honour
  the same "zero or ambiguous → null" semantics.
- 65 new vitest cases across protocol / policy-snapshot / daemon-handler
  / bundler-client / broker-client-preflight / position-deeplink test
  files. Total 474 MCP vitest cases (up from 409). Three-agent parallel
  pre-commit review (Code Reviewer + MCP Builder + Security Engineer
  fresh) absorbed: 4 HIGH addressed inline (BrokerClientError gains
  typed `brokerCode` field with `unsupported_type → version_too_old`
  remap; `attemptPathD` adds signer-mismatch guard + splits
  selector-uncapped vs selector-not-in-snapshot; test stubs replaced
  with Proxy-based throw-on-unstubbed-access); MED-1 closed (semverGte
  regex tightened to reject leading zeros per SemVer 2.0 §2). Security
  Engineer approved with no HIGH findings.

## [0.2.0] — 2026-05-18

**Minor bump signals a breaking change to `position.buy`'s input
shape.** This release consolidates the pre-Codex review of the 0.1.7
Path C bundle: 4 parallel agents (Code Reviewer, Frontend Developer,
Security Engineer, Reality Checker) surfaced ≥5 cross-confirmed HIGH
findings and several MEDIUM/LOW items. 0.2.0 lands all of them.

### Breaking

- **`muhaven.position.buy.amountUsdc6` → `amountUsdc` (human decimal).**
  Pre-0.2.0, the field was base-6 integer string ("5000000" = $5).
  An LLM hearing "buy 5 dollars" would naively emit `"5"` and silently
  produce a URL with `amount=0.000005` — user buys $5e-6 instead of $5.
  0.2.0 unifies the unit convention across the whole Path C surface
  (matches `cash.wrap.amountUsdc` shape): `"5"` means 5 mhUSDC. Max
  6 fractional digits, 48-char length cap. Server-side schema rejects
  scientific notation, leading +, thousands separators, leading zeros,
  bare leading/trailing dots.

- **`muhaven.position.sell.amountShares` rejects fractional input.**
  fhERC-20 shares are integer base units (memory:
  `project_decimals_lie_wave4_p0`). Pre-0.2.0 accepted "2.5" which
  silently floored to 2 on the on-chain submit. 0.2.0 schema regex
  `^[1-9]\d*$` rejects any fractional or leading-zero input at the
  MCP-server boundary.

- **Position tool response shape** stays the `{ dashboardUrl, action,
  instructions, echo }` format from 0.1.7 — no change here, but the
  schema breaking changes above are what trigger the minor bump per
  semver.

### Removed (cleanup of 0.1.7 deprecation candidates)

- `__resetSessionKeyProbeCacheForTests` — was retained as a no-op in
  0.1.7 for "back-compat with downstream test consumers." Verified
  empirically (Security Engineer review) that no consumer outside our
  own tests imported it. Deleted entirely.
- `formatUsdc6ToDecimal` + `computeIntentHash` +
  `PLACEHOLDER_INTENT_DOMAIN` — orphaned helpers tied to the
  pre-0.1.7 attestation path. No external consumers; deleted.

### Fixed

- **`MUHAVEN_DASHBOARD_URL` env-poisoning** (Security M-2): the URL
  is used to build every position deep-link. Pre-0.2.0, a malicious
  npm dep or attacker with write access to `~/.claude.json` could
  set `MUHAVEN_DASHBOARD_URL=https://muhaven-app.com` and have the
  MCP server route every user click to a typosquat phishing clone.
  Validation now happens at boot in `loadMcpConfig` + `loadBrokerConfig`
  using the same `https-or-loopback` rule as the existing
  `--dashboard-base-url` CLI flag. Hard-fails at server start with a
  clear error message if invalid.

- **`buildRegisterEnv` shell-metachar sanitization** (Security M-1):
  the JSON config blob passed via argv to `claude mcp add-json` could
  carry a crafted `MUHAVEN_KEYRING='file" & calc.exe &"'` past
  Windows's `shell: true` invocation, reaching `cmd.exe`'s parser as
  a command-injection vector. 0.2.0 rejects (not escapes) any value
  containing shell metacharacters (`"` `\` newline `&` `|` `;`
  `` ` `` `<` `>` `(` `)` `%` `$`) and restricts `MUHAVEN_KEYRING` to
  the recognized values (`file` / `os`). Rejected values surface as
  warnings on stderr; setup continues with the cleaned env.

- **`claude mcp remove` exit-code capture** (Code Reviewer H2 +
  Security M-3): pre-0.2.0 swallowed every exit code from the
  idempotent remove step. A perm-locked scope or stale lockfile that
  failed remove + then failed add showed an opaque error attributing
  the failure only to add. 0.2.0 captures remove's exit + stderr,
  swallows only the expected "no such server" pattern, and surfaces
  any anomaly as a warning on the success path or folds it into the
  failure reason on the error path. Closes the split-brain
  `~/.claude.json` operator-confusion class.

- **`decimalUsdcAmountSchema.max(48)` length cap** (Security L-5):
  defense-in-depth against URL bloat (LLM emits a 10MB digit string).

### Sibling commits (same hotfix bundle, deployed in lockstep)

- Backend `pg-portfolio.repository.findByUserId` now orders by
  `last_synced_at DESC NULLS LAST` so the frontend's first-seen Map
  dedup picks the freshest row — aligns the tiebreak across backend +
  frontend + dedup script (Code Reviewer N2).
- `backend/scripts/dedup-portfolios.ts` moved the discovery SELECT
  inside the dedup transaction + added `SELECT FOR UPDATE` row locks
  + `pg_advisory_xact_lock`. Closes the TOCTOU window where a
  concurrent backend write could lose data (Security H-1).
- Frontend TradePage / YieldsPage now render an inline AlertTriangle
  banner when `?token=` doesn't resolve instead of silently falling
  back to `marketplace.filtered[0]`. Closes the LLM-token-swap footgun
  (Frontend H-1).
- TradePage marketplace.load() failure surfaces a Retry CTA instead
  of half-rendering (Frontend H-2).
- TradePage / CashPage `?amount=` pre-fill uses a shared
  `sanitizePrefillAmount` helper that bounds precision to 6 dp and
  rejects fractional shares (Frontend H-4 / Code Reviewer L1).
- YieldsPage scroll-into-view moved into a watch keyed on
  `epochsStore.items.length` so deep-link landings on disconnected
  wallets still scroll once the items render (Frontend H-3).
- YieldsPage `selectedToken` declaration hoisted above onMounted so
  the deep-link path sets the ref synchronously before the
  `selectableTokens` watcher (`immediate: true`) snaps it to `list[0]`
  (Frontend H-5).

### Internal

- `__tests__/position-deeplink.test.ts`: rewrote amount tests for the
  decimal-string schema; added schema-level corpus tests pinning the
  reject list (negative, scientific notation, leading +, thousands
  separator, leading zeros, etc.); added a regression test for the
  base-6 footgun (`position.buy({amountUsdc: '5'})` must produce
  `amount=5`, NOT `0.000005`).
- `__tests__/mcp-redteam.test.ts`: updated field name from `amountUsdc6`
  to `amountUsdc` in 4 call sites.
- Total tool count unchanged at 23.

## [0.1.7] — 2026-05-18

`position.*` tools can now drive real on-chain action via @muhaven/mcp
— Path C of MCP Option A (dashboard URL elicitation → existing passkey
ceremony). Pre-0.1.7, position tools returned a placeholder UserOp
envelope + broker signature that no host could submit; the path was
attestation-only despite implying buy/sell/claim. 0.1.7 swaps the
envelope for a pre-filled dashboard deep-link URL the user opens to
review + tap their passkey through the existing dashboard flow.

### Added

- **`muhaven.cash.wrap`** — new tool. Returns a `/cash?amount=` deep-
  link for USDC → mhUSDC conversion. Common LLM chain: `read.portfolio`
  → notice 0 mhUSDC → `cash.wrap` → then `position.buy` (each is its
  own user-confirmed deep-link). Input is human-readable USDC ("100" =
  $100). 23 tools total now (was 22).

- **Token identifier accepts symbols OR addresses.** Every `position.*`
  tool's `token` field used to require a 0x-address. Now accepts either
  a symbol ("TBILL1") or a 0x-address. The dashboard pages resolve the
  symbol via the marketplace store; unknown identifiers leave the form
  blank for the user to fill in. Saves the LLM a round-trip through
  `read.tokens` for the common "buy 5 of TBILL1" flow.

- **Exported pure helpers** (`buildPositionDeeplink`,
  `formatUsdc6ToDecimal`) so third-party MCP servers + tests can reason
  about the URL shape without spawning anything.

### Changed

- **`position.buy/sell/claim` return shape** is now `{ dashboardUrl,
  action, instructions, echo }` instead of `{ intentHash,
  unsignedUserOp, brokerSignature, signerAddress }`. The `instructions`
  field is a pre-formatted two-line string the LLM can show the user
  verbatim ("Open this link to review and authorize..."). The `echo`
  field mirrors input for LLM self-verification. **Breaking** for any
  consumer that pinned the 0.1.6 response shape — the prior shape was
  itself never end-to-end usable (placeholder envelope), so the
  practical impact is "MCP buy now actually works" rather than
  regression.

- **`position.rebalance`** returns `not_implemented` with a clear
  next-step hint pointing at single-leg `position.buy` / `position.sell`
  or the dashboard. Multi-leg `execute_plan` (one URL, one passkey,
  one batched UserOp) lands in Wave 5 with composite preview UI.

- **Broker dep no longer required for position tools.** Previously, a
  `position.buy` call without a running `muhaven-broker` daemon
  returned `broker.unavailable`. Now position tools talk only to the
  dashboard URL — the broker is still needed for `read.*` / governance
  / issuer / policy tools (those use the JWT-authed path).

### Removed

- `signEnvelope` + `PositionEnvelopeData` + the per-process
  `hasSessionKey` probe cache + `__resetSessionKeyProbeCacheForTests`'s
  cache (the function is retained as a no-op for back-compat with any
  test harness importing it). The whole broker-attestation path for
  position tools is gone — they don't need a signing key at all.

### Internal

- 21 new vitest cases in `__tests__/position-deeplink.test.ts`,
  replacing `session-key-required.test.ts` (deleted — covered a
  removed code path). Total `@muhaven/mcp` suite: **262/262 passing**
  (was 241). Tool-hash count: **23** (was 22).

### Operator notes

- Once installed, the fresh-install ritual is unchanged: `muhaven-broker
  setup --register claude-code` still wires the MCP server into Claude
  Code via `claude mcp add-json`.
- Existing 0.1.6 installs: `npm install -g @muhaven/mcp@latest` picks up
  the new bin; no setup re-run needed.
- `MUHAVEN_DASHBOARD_URL` env var (defaults to `https://muhaven.app`)
  now drives the deep-link URL prefix; staging operators set it to
  `https://muhaven-staging.example` and the URLs flow through.

## [0.1.6] — 2026-05-17

Adds `muhaven-broker setup --register HOST` so a fresh install no longer
requires hand-writing a `.mcp.json` (or equivalent host-config file).
This closes the last manual step of the install ritual — operators run
one command end-to-end from `npm install -g @muhaven/mcp` to a working
MCP server registered with their host.

Initial host coverage: **Claude Code** (via `claude mcp add-json`).
`claude-desktop` and `cursor` are reserved as known host names — they
parse cleanly today but the registrar declines to act and points the
operator at the per-host JSON snippet in `docs.muhaven.app/mcp/install`.
Both ship in a Wave 5 follow-up (file-edit registrars need merge-then-
write semantics + dedicated tests).

### Added

- **`muhaven-broker setup --register HOST[,HOST...]` flag** — auto-wire
  the MCP server into one or more host configs after the login step:
  - **claude-code** (live): probes `claude --version`, removes any
    existing `muhaven` entry (idempotent), then runs
    `claude mcp add-json muhaven '{"type":"stdio","command":"muhaven-mcp","env":{...}}' --scope <scope>`.
    `env` carries `MUHAVEN_BACKEND_URL`, `MUHAVEN_DASHBOARD_URL`, and
    `MUHAVEN_KEYRING` when set (the broker session key + endpoint stay
    daemon-only — never baked into the host config).
  - **claude-desktop / cursor**: reserved names. Parse cleanly; registrar
    short-circuits with a "not implemented yet" hint pointing at the
    docs snippet. Adding a host is a focused diff: implement the
    registrar + extend `KNOWN_REGISTER_HOSTS`.
  - Accepts comma-separated values (`--register claude-code,cursor`) and
    repeated flags (`--register claude-code --register cursor`). Dedupes
    across both forms.
  - Unknown host names fail fast with exit code 2 + the allowlist in the
    error message.

- **`--register-scope user|project|local` flag** — scope for the
  `claude mcp add-json` call. Default `user` (every project on this
  machine sees the server — matches the per-user broker model);
  `project` writes `.mcp.json` at CWD (git-shared if you commit it);
  `local` writes `~/.claude.json` as a per-project user-only entry
  (Claude Code's `claude mcp add` default).

- **Pure helpers exported from `src/broker/setup.ts`** for testing +
  third-party reuse: `buildRegisterEnv`, `buildClaudeMcpRegisterJson`,
  `buildClaudeMcpAddJsonArgv`, `buildClaudeMcpRemoveArgv`,
  `registerWithHost`. Plus type exports for `RegisterHost`,
  `RegisterScope`, `RegisterHostOutcome`, `ShellResult`, and the
  `KNOWN_REGISTER_HOSTS` + `KNOWN_REGISTER_SCOPES` constants.

- **`SetupDeps.shellOut`** seam — abstracts child-process execution so
  tests can script the host-CLI responses without spawning real
  binaries. Default implementation in `cli.ts` uses `node:child_process`
  `spawn` (argv-safe — no shell interpolation of the JSON payload).

### Operator UX

- Setup's exit code is **0 on register failure**. The broker daemon and
  JWT (the load-bearing artifacts) are already in place; an opt-in
  registration failure surfaces as a warning on stderr with the exact
  re-run hint and a fallback link to the per-host JSON snippet. This
  matches the existing pattern for `--skip-login` (operator can complete
  the missing step in isolation later).

- A `cli_missing` outcome (claude binary not on PATH) is distinct from
  a `failed` outcome (claude ran but errored). The error copy reflects
  which: operators on a machine without Claude Code get an "install
  Claude Code" prompt; operators with Claude Code installed get the
  CLI's actual error message.

### Tests

- **35 new vitest cases** covering `parseSetupFlags --register / 
  --register-scope` (11), pure helpers (12), and the `registerWithHost`
  + `runSetup` integration (12). Total `__tests__/setup.test.ts` now
  93 cases. Full `@muhaven/mcp` suite: 241 cases passing.

## [0.1.5] — 2026-05-17

Adds the `muhaven-broker stop` subcommand so operators can cleanly tear
down a detached daemon spawned by `muhaven-broker setup` without
hunting for PIDs in `ps` output or hand-rolling `taskkill` recipes.
Surfaced after `muhaven-broker setup` lands in 0.1.4 — operators
naturally asked "how do I stop this?" and the answer (`muhaven-broker
logout` + manual `kill`) was non-obvious.

### Added

- **`muhaven-broker stop` subcommand** — clean shutdown:
  - Probes the broker via `hello()`. Unreachable → "not running,
    nothing to stop." exit 0.
  - Best-effort `clearJwt()` so the OS keychain doesn't keep a stale
    JWT after shutdown. Warning + continue on failure (don't abort
    the kill).
  - Reads `hello.pid` (new optional field — see below). On pre-0.1.5
    daemons that omit the field, prints a manual-kill hint with
    cross-platform commands and exits 1.
  - `process.kill(pid, 'SIGTERM')` → polls `hello()` until it fails
    (clean exit) or 5s elapses, then `process.kill(pid, 'SIGKILL')`.
  - Pure orchestrator (`runStop` in `src/broker/stop.ts`) with
    injectable IO so every branch is unit-testable without spawning
    real processes.

### Changed

- **`hello` response gains optional `pid?: number`** field (broker
  protocol stays at 0.3.0 — additive optional field, back-compat with
  pre-0.1.5 daemons). Populated from `process.pid` at request-handle
  time; consumers MUST handle `undefined` for older daemons.

### Tests

- 206 vitest pass (up from 197 in 0.1.4). Net +9 cases in new
  `__tests__/stop.test.ts`:
  - `runStop` not-running short-circuit
  - happy path (hello → clearJwt → SIGTERM → exit-detected → 0)
  - pre-0.1.5 daemon (no `pid` in hello) returns 1 with manual hint
  - SIGKILL fallback after gracefulShutdownMs timeout
  - SIGTERM permission error returns 1
  - SIGKILL permission error returns 1 with "may be orphaned" hint
  - `clearJwt` failure does NOT abort the kill (warning + continue)
  - `defaultKillProcess` returns false on ESRCH (process gone)
  - `defaultKillProcess` rethrows non-ESRCH errors (POSIX-only test)

## [0.1.4] — 2026-05-17

Adds the one-shot `muhaven-broker setup` subcommand so a fresh install
goes from `npm install -g @muhaven/mcp` straight to a working MCP host
in two commands. Surfaced during the Wave 4 demo-recording prep — the
prior five-line manual ritual (env exports + session-key mint +
background daemon + login) was the longest opaque block in the demo
script. Also adds `--version` / `--help` to both `muhaven-broker` and
`muhaven-mcp` bins.

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

  Closing summary always surfaces the broker endpoint and a
  platform-specific "Stop daemon" command (`kill <pid>` on POSIX,
  `Stop-Process -Id <pid>` on Windows). Sign-out is explicitly
  documented as separate from daemon shutdown — `muhaven-broker logout`
  clears the JWT but leaves the daemon running.

- **`muhaven-broker --version` / `-v`** — prints `muhaven-broker
  @muhaven/mcp@<version>` and exits 0. Wired into the dispatcher
  alongside the existing `--help` / `-h`. Reads the package version
  from the tsup-injected `__SERVER_VERSION__` constant.

- **`muhaven-mcp --version` / `-v` and `--help` / `-h`** — bin shim
  short-circuits before requiring `dist/index.cjs`, so the flags exit
  cleanly without spinning up the broker IPC + tool registry. Reads
  the version from the sibling `package.json` directly.

### Security

- **Session key never lands in `process.env`** — the orchestrator
  builds a local `effectiveEnv` snapshot and passes the minted
  session key only to the spawned daemon's env. Prior version
  mutated `process.env.MUHAVEN_BROKER_SESSION_KEY` so any subsequent
  child of the operator's shell would inherit the key. Foreground
  mode brackets its required `process.env` mutation in a try/finally
  that restores the original values on exit.

- **Spawned daemon strips `NODE_OPTIONS` / `NODE_TLS_REJECT_UNAUTHORIZED`
  / `NODE_EXTRA_CA_CERTS` / `NODE_PATH`** from inherited env so a
  same-user attacker who set those in the operator's shell can't
  hijack the daemon's execution to exfiltrate the session key.

- **URL flag validation** — `--backend-base-url` / `--dashboard-base-url`
  must be `https://` (with `http://localhost` / `127.0.0.1` /
  `[::1]` dev carve-out). Rejects `javascript:`, `file:`, `data:`,
  and plain `http:` to non-loopback BEFORE the spawn — defense
  against the OAuth-device-flow phishing vector where a malicious
  `--backend-base-url` would ship the JWT to an attacker host.

- **`--broker-endpoint` path validation** — must be a `\\.\pipe\…`
  path on Windows or an absolute path on POSIX. Rejects relative
  paths + flag-injection (e.g. `--broker-endpoint --from-daemon` is
  parsed but rejected at validation, preventing the spawned daemon
  from being bound to an attacker-controlled location).

- **Preserved env values not echoed** — `Env preserved: NAME (set in
  your shell)` only — values stay opaque. Prior version printed
  `Env preserved: NAME=value` which would leak operator-supplied
  values to shell history / CI logs.

- **Session key minted via viem's `generatePrivateKey`** — guarantees
  the result is in the valid secp256k1 scalar range. Prior version
  used raw `crypto.randomBytes(32)`, which had a (negligible but
  nonzero) probability of returning an out-of-range value that the
  signer would reject as invalid much later in the flow.

- **Bin path resolved via `__dirname`** — `resolveBrokerBinPath` walks
  from the bundled `dist/broker.cjs` to the sibling
  `bin/muhaven-broker.cjs` deterministically, so Windows global-npm
  shim wrappers (`.cmd` / `.ps1` in `process.argv[1]`) don't end up
  as the spawn target.

- **`detectMcpHost` no longer falls through to `npm_lifecycle_event`**
  — that var is the npm script name, not an MCP-host identity. The
  device-flow `/link` page's "requesting client" panel would have
  displayed "setup" for operators running via `npm run setup`,
  misleading the passkey ceremony.

### Tests

- 197 vitest pass (up from 134 in 0.1.3). Net +58 cases in
  `__tests__/setup.test.ts` (+22 over the initial +36 after the
  parallel agent security review) + 5 in `__tests__/cli-version-flag.test.ts`:
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
