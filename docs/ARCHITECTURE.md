# MuHaven — Technical Architecture

> System layers, contract topology, data flow, integration points, and security model.

---

## Overview

MuHaven is a confidential RWA portfolio platform on Fhenix CoFHE on Arbitrum Sepolia. It is a **two-sided platform**: issuers list tokenized RWAs through a self-serve onboarding wizard; investors purchase those tokens with encrypted balances and pull yield privately per epoch. Both sides drive the same set of contracts.

The current production deploy (2026-05-04, [`deployments/arb-sepolia-v2.json`](../deployments/arb-sepolia-v2.json)) ships **11 platform-singleton contracts** plus a **per-token contract triple** (`MuHavenToken` + `MuHavenTreasury` + `RedemptionQueue`) deployed by the onboarding wizard for every listed RWA. Two tokens are live: TBILL1 (treasury bill series 1) and GOLD1 (gold series 1).

Three system layers:

1. **Presentation** — Vue 3 dashboard for investors and issuers; ZeroDev passkey kernel + scoped `@zerodev/permissions` session keys for gasless UserOps. AI-agent chat UI scaffolded; full agentic execution loop in active Wave 4 development.
2. **Application** — `@muhaven/sdk` TypeScript SDK orchestrating the contract pipeline; backend (REST API + auth + portfolio aggregation + issuer tools), FHE worker (server-side `@cofhe/sdk/node`), NAV worker (FRED + on-chain + fallbacks), NAV publisher (writes oracle on-chain with deviation + sequencer-uptime gates).
3. **Protocol** — MuHaven contracts on Arb Sepolia (atomic `MuHavenSubscription`, per-token `MuHavenTreasury`, pluggable `IPriceOracle`, `RedemptionQueue`, pull-based `YieldSnapshot`, ERC-3643 modular compliance topology, `MuHavenStable` mhUSDC wrapper).

Encryption is provided by Fhenix CoFHE; settlement is `MuHavenStable` (mhUSDC, MuHaven's own confidential USDC wrapper layered over legacy ReineiraOS PUSDC because PUSDC's pre-v0.1.0 `euint64 = uint256` selector mismatched the post-v0.1.0 `bytes32` ABI MuHaven contracts compile against).

---

## System layers

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  PRESENTATION                                                                │
│                                                                              │
│  ┌────────────────────────────┐         ┌────────────────────────────────┐   │
│  │ Investor Dashboard (Vue 3) │         │ Issuer Dashboard (Vue 3)       │   │
│  │ - Wrap → mhUSDC            │         │ - Onboarding wizard            │   │
│  │ - Buy / Redeem (atomic)    │         │ - NAV writes                   │   │
│  │ - Claim yield per epoch    │         │ - Open / snapshot / fund epoch │   │
│  │ - Set risk policy          │         │ - Compliance modules           │   │
│  │ + HavenBot chat (Wave 4)   │         │                                │   │
│  └──────────────┬─────────────┘         └─────────────────┬──────────────┘   │
│                 │                                         │                  │
│       ZeroDev kernel + passkey + scoped session keys (`@zerodev/permissions`)│
└─────────────────┼─────────────────────────────────────────┼──────────────────┘
                  │                                         │
┌─────────────────▼─────────────────────────────────────────▼──────────────────┐
│  APPLICATION                                                                 │
│                                                                              │
│  ┌────────────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │ @muhaven/sdk           │  │ Backend (Node 20)│  │ Workers (Docker)     │  │
│  │ - MuHavenClient        │  │ - REST API       │  │ - fhe-worker         │  │
│  │ - SubscriptionClient   │  │ - Auth (passkey) │  │   (@cofhe/sdk/node)  │  │
│  │ - TreasuryClient       │  │ - Portfolio agg  │  │ - nav-worker (FRED,  │  │
│  │ - RedemptionQueueClient│  │ - Issuer ops     │  │   on-chain, fallback)│  │
│  │ - YieldSnapshotClient  │  │ - Webhook ingest │  │ - nav-publisher      │  │
│  │ - OracleClient         │  │ - Drizzle / PG   │  │   (oracle writes)    │  │
│  └───────────┬────────────┘  └────────┬─────────┘  └──────────┬───────────┘  │
└──────────────┼───────────────────────┼────────────────────────┼──────────────┘
               │                       │                        │
┌──────────────▼───────────────────────▼────────────────────────▼──────────────┐
│  PROTOCOL (Arbitrum Sepolia)                                                 │
│                                                                              │
│  Platform singletons:                                                        │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ MuHavenStable (mhUSDC, confidential USDC wrapper)                      │  │
│  │ MuHavenSubscription (atomic single-tx buy/redeem coordinator)          │  │
│  │ TokenRegistry · InvestorRegistry · YieldSnapshot                       │  │
│  │ MuHavenIdentityRegistry + ClaimTopicsRegistry + TrustedIssuersRegistry │  │
│  │ ModularCompliance + modules (CountryAllow / MaxHolders / Lockup / ...) │  │
│  │ IssuerControlledOracle · ChainlinkFunctionsOracle                      │  │
│  │ RiskParams (encrypted investor guardrails)                             │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  Per-token (deployed by the onboarding wizard, one set per RWA):             │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ MuHavenToken (fhERC-20) · MuHavenTreasury · RedemptionQueue            │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
                  │
┌─────────────────▼────────────────────────────────────────────────────────────┐
│  ENCRYPTION                                                                  │
│                                                                              │
│  Fhenix CoFHE coprocessor — async-decrypt for on-chain plaintext, permit-    │
│  based decryptForView for client UI; encrypted types ebool, euint8…128,      │
│  eaddress; FHE.add/sub/mul/div/select/gte etc. on ciphertext                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Contract architecture

### Topology

Wave 3 retired `MuHavenVault` (wrap/unwrap), `YieldDistributor` (push proportional escrow creation), `MuHavenEscrow` (per-investor two-phase yield escrow), `YieldGate` (escrow condition resolver), and `ERC3643KYCAdapter` (whitelist-only IKYCGate adapter). The current pipeline replaces those with atomic Subscription + pull-based YieldSnapshot + ERC-3643 modular compliance.

```
Investor purchase:
  passkey → kernel UserOp
    └─ MuHavenSubscription.purchase(token, encAmount, maxSharesHint, ephEOA)
        ├─ ModularCompliance.canTransfer(token, mint convention) ─── short-circuit AND
        │   └─ CountryAllow / CountryRestrict / MaxHolders / Lockup / MaxBalance
        ├─ MuHavenIdentityRegistry.isVerified(investor)
        ├─ IPriceOracle.getNAV(token)                                ┐ pluggable
        │   └─ IssuerControlledOracle (issuer-write, deviation gate, sequencer)
        │   └─ ChainlinkFunctionsOracle (FRED DGS3MO / GOLDPMGBD228NLBM, fallback)
        ├─ FHE.mul(encAmount, NAV) → encShares (silent-fail bound by maxSharesHint)
        ├─ MuHavenStable.transferFrom(investor, treasury, encAmount, ephEOA, addr0)
        ├─ MuHavenToken.mintFromSubscription(investor, encShares, ephEOA)
        └─ FHE.allow(handles, ephEOA)  // permit grants for client decrypt

Yield epoch (issuer-driven, paginated):
  YieldSnapshot.openEpoch(token)
    └─ YieldSnapshot.snapshotBatch(token, epochId, holders[])  // idempotent
        └─ MuHavenToken.snapshotBalance(holder)               // re-grants ACL
          └─ accumulates encTotalSupply running sum
  YieldSnapshot.finalizeSnapshot(token, epochId)
  YieldSnapshot.fundEpoch(token, epochId, totalYield, ratePerShare)
    └─ MuHavenStable.transferFrom(issuer, snapshot, totalYield, ...)

Investor claim (pull-based, idempotent):
  YieldSnapshot.claimYield(token, epochId, ephEOA)
    └─ FHE.mul(snapshotBalance, ratePerShare) ÷ RATE_SCALE
    └─ MuHavenStable.trustedPayout(snapshot, investor, encShare64, ephEOA)

Redemption (instant + queued overflow):
  MuHavenSubscription.redeem(token, encShares, maxSharesHint, ephEOA)
    instant branch: cap untouched
      └─ MuHavenToken.burnFromSubscription + MuHavenStable.transferFrom
    overflow branch: per-epoch cleartext cap exceeded
      └─ RedemptionQueue.submitFor(investor, encShares, hint, ephEOA)
  RedemptionQueue.processEpoch(token, epochId, NAV)  // issuer-driven
  RedemptionQueue.claim(requestId)                    // investor-pull
```

### Per-contract roles

| Contract | Layer | Role |
|---|---|---|
| `MuHavenStable.sol` | platform | Confidential USDC wrapper (mhUSDC). `_silentFailBound` semantics. `trustedPayout` fast-path for known-conservation callers (snapshot / queue). |
| `MuHavenSubscription.sol` | platform | Atomic single-tx buy/redeem coordinator. KYC + compliance + oracle + FHE.mul + mhUSDC pull + mint (or burn + pay-out). Auto-escalates to queue on cap overflow. |
| `MuHavenToken.sol` | per-token | fhERC-20 RWA token (`euint128`). `SUBSCRIPTION_ROLE` only mint authority; `transfer`/`transferFrom` call `InvestorRegistry.addHolder` on first transfer-in. |
| `MuHavenTreasury.sol` | per-token | Per-token mhUSDC custody. Immutable operator approvals to Subscription + Queue at init. `minFloat` solvency floor via silent-fail `FHE.select`. |
| `RedemptionQueue.sol` | per-token | Overflow redemption queue. `submit` captures `ephEOA` + `maxSharesHint`. `processEpoch` settles at issuer-published NAV. `claim` pays from treasury. `cancelOnKYCRevocation` returns shares. |
| `YieldSnapshot.sol` | platform | Pull-based per-epoch yield distribution. `openEpoch` → paginated `snapshotBatch` (idempotent, accumulates `encTotalSupply`) → `finalizeSnapshot` → `fundEpoch` (cleartext fixed-point `ratePerShare`) → `claimYield(epochId, eph)` (pull, idempotent, payout via `trustedPayout`). |
| `TokenRegistry.sol` | platform | Per-token configuration registry. Issuer, oracle binding, treasury / queue / snapshot pointers, paused flag, schedule metadata. |
| `InvestorRegistry.sol` | platform | Per-token holder enumeration. `addHolder` called by `MuHavenToken._transfer` on first transfer-in. Used by `YieldSnapshot.snapshotBatch` + `MaxHolders` compliance module. |
| `MuHavenIdentityRegistry.sol` | platform | ERC-3643 identity registry. `isVerified(addr)` runs whitelist → claim verification (topics × trusted issuers × `validUntil`). `devMode` flag for migration; `disableDevModeForever()` is irreversible. |
| `ClaimTopicsRegistry.sol`, `TrustedIssuersRegistry.sol` | platform | ERC-3643 auxiliary registries. |
| `ModularCompliance.sol` | platform | Per-token rule-modules registry. `canTransfer` AND-aggregates active modules with short-circuit; state hooks fire on mint / transfer / burn. |
| `CountryAllow`, `CountryRestrict`, `MaxHolders`, `Lockup`, `MaxBalance` | platform | Pluggable compliance modules implementing `IComplianceModule`. |
| `IssuerControlledOracle.sol` | platform | Pluggable `IPriceOracle` reference impl — issuer-write NAV with rotation, configurable staleness window, deviation gate (per-token `maxDeviationBps`, pending state on gate failure), L2 sequencer-uptime check via Chainlink-shaped feed. |
| `ChainlinkFunctionsOracle.sol` | platform | Functions-backed `IPriceOracle` — pulls FRED `DGS3MO` for treasury bills, FRED `GOLDPMGBD228NLBM` (or metals-api fallback) for gold. Per-token `navRequester` hot key. |
| `RiskParams.sol` | platform | Encrypted investor risk guardrails (4× `euint64`) — max drawdown, min yield, drift tolerance, max daily spend. Wave 4 P6 added the branchless `FHE.select` hot path (`checkAndExecute` returning `(ePassed, breachId)`), breach-only async-decrypt (`settleBreachDecrypt`), encrypted signal flags (`computeSignalFlags`), and the investor-signed `AgentPermit` EIP-712 schema — see `SMART_CONTRACTS.md` §11. |

### Critical CoFHE patterns

Every MuHaven contract follows these patterns. Breaking any of them causes silent failures or information leaks. Full canonical reference in [SMART_CONTRACTS.md § Critical CoFHE patterns](./SMART_CONTRACTS.md#critical-cofhe-patterns).

1. **Access control after every FHE op.** Every new handle from `FHE.add` / `FHE.sub` / `FHE.select` / `FHE.asEuint*` / `FHE.asEaddress` is granted via `FHE.allowThis` (contract reuse) and, where the value is investor-decryptable, `FHE.allow(handle, ephemeralEOA)` per ADR-021 (the ephemeral-EOA permit signer pattern that replaced kernel-signed permits).
2. **Permit-based client decrypt.** `cofheClient.decryptForView(ctHash).withPermit().execute()` reads the current handle through the user's ephemeral-EOA permit. `sealOutput` / `sealoutputTyped` was removed in cofhe-contracts v0.1.3.
3. **Silent failure with `FHE.select`.** Branchless conditional zero on insufficient balance / cap overflow / solvency-floor breach. Same gas cost on success and failure paths — observers cannot distinguish.
4. **Guarded uninitialized handles.** `Common.isInitialized(handle)` before reading mapping-default `euint*` slots.
5. **Async decrypt only when plaintext must reach the EVM.** `ITaskManager.createDecryptTask(handle)` + `FHE.getDecryptResultSafe(handle)` for on-chain plaintext (e.g. governance tally). `decryptForTx` + `publishDecryptResult` is the canonical breach-decrypt flow.
6. **Silent-fail-bounded conservation primitives.** Operations that move encrypted amounts on behalf of an investor (escrow / snapshot / distributor payouts) return the silent-fail-bounded actual handle, never the requested amount, so downstream contracts can't be spoofed into spending more than was conserved on the input leg (ADR-030 + ADR-036).

---

## Data flow

### Flow 1 — Investor onboarding + atomic purchase

1. Visitor signs in with passkey → ZeroDev kernel deploys (or recovers) → SIWE-style nonce/verify against backend → JWT issued. Frontend installs a session-key validator scoped to a narrow allowlist of MuHaven function calls, valid for `VITE_SESSION_KEY_DURATION_SEC` (default 1h).
2. Investor wraps USDC into mhUSDC via `MuHavenStable.wrap(amount)` (cleartext USDC in, encrypted mhUSDC out — the only point where the deposit size leaks).
3. Investor browses `/tokens`, selects a listed RWA, and submits `MuHavenSubscription.purchase(token, encAmount, maxSharesHint, ephemeralEOA)` as a single UserOp (gasless via ZeroDev paymaster).
4. The Subscription contract atomically: checks `MuHavenIdentityRegistry.isVerified(msg.sender)`; runs `ModularCompliance.canTransfer(...)` AND-aggregating active modules with short-circuit; reads `IPriceOracle.getNAV(token)` with freshness + deviation + sequencer-uptime gates; computes `encShares = FHE.mul(encAmount, NAV)` silent-fail-bounded by `maxSharesHint`; pulls mhUSDC via `MuHavenStable.transferFrom(...)`; mints fhERC-20 via `MuHavenToken.mintFromSubscription(investor, encShares, ephEOA)`; calls `FHE.allow` on the new investor balance handle granting the ephemeral-EOA permit access.
5. The investor's portfolio page decrypts the new balance via `cofheClient.decryptForView(ctHash).withPermit().execute()` — no on-chain task, no polling.

### Flow 2 — Issuer yield epoch (open → snapshot → finalize → fund)

1. Issuer opens `/distribute` for a token, sets total yield + per-share rate, and submits `YieldSnapshot.openEpoch(token)`. The snapshot contract allocates a sequential `epochId` and records `snapshotStartTs`.
2. SDK paginates `InvestorRegistry.getInvestors(token, offset, limit)` and calls `YieldSnapshot.snapshotBatch(epochId, holders[])` in batches. Each entry captures the holder's balance via `MuHavenToken.snapshotBalance(holder)` (which re-grants the issuer's ACL on the snapshot handle per ADR-049). The snapshot contract accumulates `encTotalSupply` as a running sum (ADR-038 — closes the pool-drain vector under mid-snapshot mutations).
3. Issuer submits `YieldSnapshot.finalizeSnapshot(token, epochId)`, locking the phase. `EmptySnapshot` reverts when `holderCount == 0`.
4. Issuer submits `YieldSnapshot.fundEpoch(token, epochId, totalYield, ratePerShare)`. The snapshot pulls mhUSDC from the issuer and stores `ratePerShare` (cleartext fixed-point at `RATE_SCALE = 1_000_000` — see ADR-048). The cleartext rate is by-design: per-share yield rates (TBILL APY, dividend rate) are conventionally published off-chain; per-investor balances + per-claim shares stay encrypted; conservation is enforced off-chain by the issuer (`ratePerShare ≤ floor(totalYield / totalSupply)`).
5. Frontend exposes a "Decrypt from chain" button on `/distribute` that pre-fills the supply input from the snapshot's `encTotalSupply` (per-investor balances stay encrypted; only the SUM is disclosed to the issuer).

### Flow 3 — Investor claim (pull-based, per-epoch)

1. Investor opens `/yields` → sees claimable epochs for tokens they held at snapshot → clicks "Claim" on an epoch.
2. SDK submits `YieldSnapshot.claimYield(token, epochId, ephemeralEOA)` as a UserOp through the ZeroDev kernel (silent within the active session).
3. Snapshot contract computes `encShare128 = FHE.mul(snapshotBalance, FHE.asEuint128(ratePerShare))`, then `encShare64 = FHE.div(encShare128, FHE.asEuint128(RATE_SCALE))` for the rescale (ADR-048 sub-1:1 yield support).
4. Snapshot calls `MuHavenStable.trustedPayout(snapshot, investor, encShare64, ephEOA)` — the fast-path that bypasses `_silentFailBound` because per-epoch conservation guarantees the snapshot's float covers every legitimate claim (ADR-046 / Phase 8 Option B).
5. Investor's `/cash` (mhUSDC balance) updates within seconds; `decryptForView` confirms.

### Flow 4 — Issuer onboarding wizard (Phase 9.A · F2)

1. Applicant connects passkey → KYB gate (auto-approved on testnet `devMode`; mainnet path runs full ERC-3643 claim verification).
2. Wizard collects token metadata (name, symbol, NAV oracle binding, compliance module set), validates per-step in the browser.
3. Single transaction batch deploys per-token contract triple — `MuHavenToken` + `MuHavenTreasury` + `RedemptionQueue` proxies — registers the token in `TokenRegistry`, binds compliance modules, and grants `SUBSCRIPTION_ROLE` to `MuHavenSubscription` and `BURN_ROLE` to `RedemptionQueue` on the new token.
4. Token registers paused; operator (or wizard step 6) runs `scripts/unpause-token.ts` to set initial NAV and flip `paused=false` (this script is hardened with explicit `MUHAVEN_ENV` + try/finally restore on the navWriter rotation — see DEV_LOG entry 2026-05-04).

---

## Integration points

### MuHaven ↔ Fhenix CoFHE

- **What.** All encrypted types (`euint8`…`euint128`, `eaddress`, `ebool`) and FHE operations (`add`, `sub`, `mul`, `div`, `gte`, `lte`, `select`, `allow`, `allowThis`, `allowSender`, `allowPublic`, `getDecryptResultSafe`).
- **How.** Solidity imports `@fhenixprotocol/cofhe-contracts/FHE.sol` (v0.1.3). Client SDK uses `@cofhe/sdk` (v0.5.1), TFHE runtime v1.5.3 in the browser. `@cofhe/hardhat-plugin` + `@cofhe/mock-contracts` for testing.
- **Permits.** Ephemeral-EOA pattern (ADR-021): every mutation that produces investor-decryptable state grants `FHE.allow(handle, ephemeralEOA)` to the user's per-session signer; client signs decrypt permits with the same eph. Replaces the legacy kernel-signed permit flow that broke under post-deploy ERC-1271 verification timing.

### MuHaven ↔ MuHavenStable (mhUSDC)

- **What.** Confidential USDC wrapper layered over the legacy ReineiraOS PUSDC ABI. Adds `_silentFailBound` semantics, per-leg `ephemeralEOA` ACL grants on `transferFrom` (5-arg overload, ADR-044), and `trustedPayout` (ADR-046) for known-conservation callers.
- **Why.** PUSDC's pre-v0.1.0 deployed `ConfidentialUSDC` on Arb Sepolia uses `euint64 = uint256` at the ABI level; MuHaven contracts compile against `euint64 = bytes32` (post-v0.1.0). MuHavenStable shims the selector with a low-level call when forwarding to PUSDC and exposes a clean MuHaven-flow surface to its callers.
- **Where.** Settlement currency for every MuHaven flow — `Subscription.purchase` (mhUSDC pull), `Subscription.redeem` (mhUSDC pay-out), `YieldSnapshot.fundEpoch` (issuer→snapshot), `YieldSnapshot.claimYield` (snapshot→investor via `trustedPayout`), `RedemptionQueue.processEpoch` (treasury→queue), `RedemptionQueue.claim` (queue→investor).

### MuHaven ↔ ERC-3643

- **What.** T-REX modular-compliance topology for regulated securities. `MuHavenIdentityRegistry` checks claim verification (topics × trusted issuers × `validUntil`); `ModularCompliance` AND-aggregates rule modules; auxiliary `ClaimTopicsRegistry` + `TrustedIssuersRegistry` host the claim taxonomy.
- **How.** `MuHavenSubscription.purchase` and `MuHavenToken._transfer` both consult `MuHavenIdentityRegistry.isVerified(addr)` and `ModularCompliance.canTransfer(token, from, to)` before any FHE op. State hooks (`created` / `transferred` / `destroyed`) fire on every supply mutation so modules like `MaxHolders` can update counters.
- **Migration.** `devMode` flag on `MuHavenIdentityRegistry` permits all addresses during testnet operation (ADR-011); `disableDevModeForever()` is an irreversible latch (ADR-023) for the production cutover.

### MuHaven ↔ Chainlink Functions

- **What.** Off-chain NAV pulls for `ChainlinkFunctionsOracle`. CBOR request bodies stored per-token (`setTokenConfig`); router callback writes the new NAV through `IIssuerControlledOracle.setNAV(token, value)` after verifying the per-token `navRequester` matches the consumer.
- **Sources.** FRED `DGS3MO` (3-month T-bill) for TBILL1; FRED `GOLDPMGBD228NLBM` (London PM gold fix) for GOLD1, with metals-api.com as fallback (swap CBOR body, no code path change).
- **Production.** Subscription ID `567` on Arb Sepolia DON `fun-arbitrum-sepolia-1`.

### MuHaven ↔ ZeroDev

- **What.** ERC-4337 Kernel smart account + WebAuthn passkey + `@zerodev/permissions` session-key validators (`CallPolicy` + `GasPolicy` + `RateLimitPolicy`).
- **How.** `frontend/src/providers/zerodev/` handles registration, login, and session-key install. After the first passkey sign-in, a session-key validator is installed scoped to a narrow allowlist of MuHaven function calls valid for the configurable session duration. Subsequent writes within the session are signed locally by the session key — no passkey prompt.
- **Wave 4 plan.** Agent layer reuses the same kernel + session-key surface; agent-issued UserOps run through additional `@zerodev/permissions` policies (per-target selector allowlist, value cap per call, total cap per epoch, validity ≤ chat session). The agent never holds a private key.

### MuHaven ↔ ReineiraOS

- **Substrate role.** MuHaven's backend is forked from the ReineiraOS Platform Modules starter (Clean Architecture layout, ZeroDev passkey kernel provider, Drizzle repositories) and adapted. Privara is ReineiraOS's consumer app layer — MuHaven uses ReineiraOS Platform Modules directly, not Privara as an SDK.
- **PUSDC role.** Settlement now goes through `MuHavenStable` (mhUSDC), not legacy PUSDC directly. PUSDC is shimmed inside MuHavenStable; nothing in user-facing flows touches PUSDC at the application layer.

---

## Backend services

A 5-service Docker stack runs on a homelab behind a Cloudflare tunnel. Production at `api.muhaven.app` (master branch); staging at `api-stage.muhaven.app` (agenticwave branch). The two stacks are physically isolated (separate compose projects, never share Postgres).

| Service | Image | Role |
|---|---|---|
| `postgres` | `postgres:16-alpine` | Drizzle schema store — users, sessions, RWA tokens, holdings, epochs, queue requests, NAV history, audit log |
| `backend` | local build | REST API — passkey auth (ZeroDev kernel link + JWT), portfolio aggregation, issuer onboarding, yield + redemption queries, NAV writer endpoints, webhook ingest, agent chat stub |
| `fhe-worker` | local build | Server-side CoFHE encryption via `@cofhe/sdk/node` (isolated from the API pod) |
| `nav-worker` | local build | Periodic NAV fetcher — FRED treasury yields, on-chain oracles, source-audit-trail with fallbacks |
| `nav-publisher` | local build | On-chain NAV writer — pulls fresh values from `nav-worker` and pushes to `IssuerControlledOracle` per token, gated by deviation + sequencer-uptime checks |

Deploy is a single command from the dev machine:

```bash
pnpm run deploy:homelab          # prod  · master       → api.muhaven.app
pnpm run deploy:homelab:stage    # stage · agenticwave  → api-stage.muhaven.app
```

Both wrap `scripts/deploy-homelab.sh <env>` (branch-guarded, always passes `-f` + `-p` so the two compose projects stay isolated). Postgres is never restarted; backend / fhe-worker / nav-worker / nav-publisher rebuild incrementally.

Setup details, env-var tables per service, and Cloudflare tunnel config: [BACKEND_SETUP.md](./BACKEND_SETUP.md).

---

## Security model

### Trust assumptions

| Component | Trust level | Mitigation |
|---|---|---|
| Fhenix CoFHE coprocessor | External — FHE-key compromise would expose all encrypted state | Threshold decryption distributes keys across multiple parties; current testnet runs Fhenix's interim "training-wheels" trust model documented to MuHaven users |
| MuHavenStable (mhUSDC) | Owned — `_trustedPayer` mapping gated by owner; `trustedPayout` is the only ACL bypass | Per-leg `ephemeralEOA` grants on `transferFrom`; `setTrustedPayer` folded into `deploy-v2.ts` (Phase 10 fix) so fresh deploys are claim-ready by construction |
| ZeroDev kernel + passkey | User holds passkey on device (WebAuthn) | Session keys scoped to narrow MuHaven allowlist + time-limited; passkey RP ID bound to `muhaven.app` (prod, eTLD+1) / `stage.muhaven.app` (stage subdomain — separate WebAuthn credential set from prod) |
| Per-token issuer | Issuer signs `IssuerControlledOracle.setNAV` and `YieldSnapshot.fundEpoch`; cleartext `ratePerShare` self-attests | Off-chain conservation enforcement; deviation gate rejects out-of-range NAV writes; `disableDevModeForever()` latch closes the migration KYC bypass |
| ERC-3643 trusted issuers | Trusted issuers vouch for KYC status | Multiple issuers can be required; issuer registry on-chain in `TrustedIssuersRegistry` |
| AI agent (Wave 4) | Scaffolded only — no execution loop in production | Tiered-autonomy state machine + deterministic policy gate between LLM and signing path (CaMeL planner/action split). See [AGENT_DESIGN.md](./AGENT_DESIGN.md) |

### Wallet model (shipped)

Users authenticate with a **passkey** (WebAuthn) attached to a **ZeroDev smart account** (EIP-4337 kernel). All user writes are UserOps signed by the passkey and relayed through ZeroDev's bundler + paymaster (gasless). After the first sign-in, the frontend installs a session-key validator scoped to a narrow allowlist of MuHaven function calls valid for `VITE_SESSION_KEY_DURATION_SEC` (default 1 hour). Subsequent writes within the session are signed locally by the session key — the prompt budget for a typical investor session drops from "every action" to two-then-zero passkey dialogs.

**Production upgrade (post-Wave-4).** Migrate from ZeroDev's kernel-specific permission system to [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702) native session keys once EIP-7702 finalizes and wallet support lands. Both ERC-7710 and ERC-7715 stay Draft as of mid-2026; MuHaven wires through `@zerodev/permissions` abstractions, not raw 7715 RPC, until Last Call.

### Agent security model (Wave 4 — in active development)

The Wave 4 plan covers four agentic surfaces — **HavenBot** (in-dashboard streaming chat), **`@muhaven/mcp`** (MCPB-format MCP server), **OpenClaw skill** (`muhaven-rwa-skill` published to ClawHub), and **hosted checkout** (`muhaven.app/pay`) — plus a tiered-autonomy state machine (Advisory / Confirm-per-action / Policy-bound) and hybrid encrypted-policy storage (encrypted thresholds in `RiskParams.sol`, plaintext rule-shape in `@zerodev/permissions` validators).

The agent never holds a private key. It reuses the user's authenticated kernel + session keys, with additional permission constraints when an agent acts on the user's behalf (per-target selector allowlist, value cap per call, total cap per epoch, validity ≤ chat session). A deterministic policy gate sits between the LLM and the signing path (CaMeL planner/action split) so prompt injection cannot reach permission-grant or tx-submission surfaces.

Risk register R-1..R-8 (prompt injection, hallucinated tool calls, replay attacks, supply-chain, MCP env-block exfil, etc.) is documented in [AGENT_DESIGN.md](./AGENT_DESIGN.md) and `development/WAVE_PLAN.md` § "Wave 4".

---

## Deployment

### Testnet (current)

- **Chain.** Arbitrum Sepolia (`421614`).
- **CoFHE.** Fhenix testnet coprocessor.
- **Frontend.** [muhaven.app](https://muhaven.app) (prod) · `stage.muhaven.app` (staging).
- **Backend.** [api.muhaven.app](https://api.muhaven.app) (prod) · `api-stage.muhaven.app` (staging).
- **Contracts.** [`deployments/arb-sepolia-v2.json`](../deployments/arb-sepolia-v2.json) — fresh deploy 2026-05-04, deployer `0xe11E…6986`. All proxies + implementations verified on Arbiscan. Wave 3 read-only artifact at [`deployments/arb-sepolia.json`](../deployments/arb-sepolia.json).
- **Tokens onboarded.** TBILL1 + GOLD1 via `bash scripts/onboard-token.sh <symbol>`.

### Production (Arbitrum One)

- **Chain.** Arbitrum One.
- **CoFHE.** Fhenix production coprocessor (when available).
- **Audit.** Required before mainnet deployment.
- **Timelock.** Admin upgrades through delay + multisig.
- **KYC.** `MuHavenIdentityRegistry.disableDevModeForever()` invoked as part of the cutover; full ERC-3643 claim verification path active.

### Operational scripts

| Script | Purpose |
|---|---|
| `pnpm run deploy:v2:testnet[:stage]` | Platform deploy — 11 singletons. Folds `setTrustedPayer` so fresh deploys are claim-ready by construction (Phase 10 fix). |
| `bash scripts/onboard-token.sh <symbol>` | Per-token deploy via the wizard primitives — Token + Treasury + Queue + register + bind compliance modules. Preset env files at `scripts/env/<symbol>.env`. |
| `MUHAVEN_ENV=prod pnpm hardhat run scripts/upgrade-stable.ts` | Upgrade `MuHavenStable` implementation with ACL re-grant. Prints the follow-up `grant-trusted-payer.ts` command in its checklist. |
| `MUHAVEN_ENV=prod pnpm hardhat run scripts/upgrade-yield-snapshot.ts` | Upgrade `YieldSnapshot` with pre-flight epoch enumeration (aborts if any funded-not-swept epoch has unscaled `0 < ratePerShare < RATE_SCALE`). Operator override: `MUHAVEN_ALLOW_PRE_L1_INFLIGHT=1`. |
| `MUHAVEN_ENV=prod pnpm hardhat run scripts/grant-trusted-payer.ts` | Post-`upgrade-stable.ts` rewire / botched-deploy recovery (idempotent — reads `isTrustedPayer` first). |
| `MUHAVEN_ENV=prod pnpm hardhat run scripts/unpause-token.ts` | Operator helper — `setNAV` + `setPaused(false)` with try/finally `navWriter` restore safety. Required env: `MUHAVEN_TOKEN_SYMBOL`, `MUHAVEN_INITIAL_NAV`. |

Full per-script docstrings live in `scripts/`. The `upgrade-*.ts` scripts use OZ Upgrades' transparent-proxy admin and the locked-storage `__gap` patterns inherited from each contract's initial layout.
