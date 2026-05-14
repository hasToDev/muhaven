<img src="./docs/images/logo-text.jpg" alt="MuHaven Logo" width="850" />

# MuHaven

**The first autonomous RWA portfolio manager where nobody can see your strategy, your balances, or your yields — not even the agent. A two-sided platform: issuers create tokens with confidential distribution, investors manage portfolios with AI-powered privacy.**

---

### Quick navigation

| Document | Description |
|----------|-------------|
| [Architecture](./docs/ARCHITECTURE.md) | System layers, data flow diagrams, integration points |
| [Smart Contracts](./docs/SMART_CONTRACTS.md) | Contract specs, interfaces, EIP compliance, Solidity code |
| [MuHaven SDK](./docs/SDK.md) | TypeScript SDK — quickstart, API reference, integration guide |
| [AI Agent Design](./docs/AGENT_DESIGN.md) | Agent architecture, tool definitions, four-surface rollout (chat scaffold shipped, full agentic layer in active Wave 4 development) |
| [Issuer Model](./docs/ISSUER_MODEL.md) | Supply side: how RWA tokens enter MuHaven, yield flow, issuer experience |
| [Token Lifecycle](./docs/TOKEN_LIFECYCLE.md) | Four-state lifecycle model: Active → Paused → Winding Down → Archived (post-hackathon spec) |
| [Threat Model](./docs/THREAT_MODEL.md) | Privacy boundary, known leakage points, side-channel resistance, ZK/TEE/MPC comparison |
| [Credit Protection Design](./docs/CREDIT_PROTECTION_DESIGN.md) | DefaultProtection + EncryptedGovernance + KYC attestation contract specs (Wave 4) |
| [Competitive Analysis](./docs/COMPETITIVE_ANALYSIS.md) | Market positioning vs. Canton, Silent Data, DeFAI |
| [Testnet Deployment](./docs/TESTNET_DEPLOY.md) | Step-by-step guide: env setup, deploy, verify, test |
| [Backend Setup](./docs/BACKEND_SETUP.md) | Docker stack (postgres + backend + FHE worker + NAV worker + NAV publisher), env vars, Cloudflare tunnel |

---

## The Problem

### Real-World Assets on public blockchains are broken by design

Tokenized Real-World Assets (RWAs) — treasuries, bonds, real estate, private credit — represent a $29B+ on-chain market with 385,000+ asset holders as of late 2025. By 2030, this market is projected to reach $30 trillion.

But every single one of those holders has a critical vulnerability: **their entire financial position is public.**

On any EVM chain, standard ERC-20 tokens expose everything. Balances, transfer amounts, transaction history — all visible to anyone with a block explorer. For tokenized securities, this creates four concrete risks:

1. **Wealth profiling** — Once a wallet is linked to an identity (through KYC onboarding or on-chain analytics), anyone can estimate an investor's net worth and portfolio composition.

2. **Strategy leakage** — Competitors and MEV bots can observe accumulation patterns, rebalancing activity, and yield claiming behavior in real time.

3. **Yield inference** — Even if balances were hidden, yield distributions (bond coupons, dividends, rental income) broadcast position sizes by implication. If someone receives $4,200/month from a 6% fund, they hold ~$840,000.

4. **Physical security risk** — Large on-chain balances tied to real identities through KYC create targets for social engineering and physical threats.

<img src="./docs/images/problem-visualization.jpg" alt="Problem visualization" width="850" />

### Why existing solutions fail

| Approach | Examples | What it does | What it can't do |
|----------|----------|-------------|------------------|
| **Permissioned chains** | Canton Network, Silent Data L2 | Restricts who can see data | Kills composability — no DeFi integration |
| **ZK identity** | zkMe, Polygon ID | Proves credentials privately | Can't encrypt ongoing balances or compute on them |
| **Mixers** | Tornado Cash model | Hides transaction graph | Regulatory poison for securities; no balance privacy |
| **Off-chain state** | Most current RWA platforms | Keeps data in traditional databases | Defeats the purpose of blockchain entirely |

The root issue: **RWA privacy isn't a verification problem (which ZK solves) — it's a persistent encrypted state problem.** You need balances, yields, and eligibility to remain encrypted on-chain as live, computable values that smart contracts operate on continuously.

### The DeFAI blind spot

The DeFAI (DeFi + AI) market is exploding — AI agents that manage portfolios, optimize yields, and execute trades autonomously. But every existing DeFAI agent operates on **transparent state**. When an AI agent rebalances a portfolio, the entire strategy is visible on-chain. Competitors copy it. MEV bots front-run it. The agent's edge evaporates the moment it acts.

---

## The Solution

### MuHaven: Confidential DeFAI for Real-World Assets

MuHaven is the first confidential, AI-powered RWA portfolio manager. It's a **two-sided platform**: issuers create and list RWA tokens, deposit yield, and manage distribution — while investors manage portfolios with AI-powered privacy. Nobody can see the strategy, the balances, or the yields. Not competitors, not MEV bots, not even the agent itself.

> **Status (production live · 2026-05-04):** the full **production-grade RWA flow** is deployed on Arbitrum Sepolia and serving traffic at [muhaven.app](https://muhaven.app) (frontend) backed by [api.muhaven.app](https://api.muhaven.app) (API). 11 platform contracts behind transparent proxies — atomic `MuHavenSubscription` for buy/redeem, per-token `MuHavenTreasury` custody, pluggable `IPriceOracle` with `IssuerControlledOracle` + `ChainlinkFunctionsOracle` reference impls, `RedemptionQueue` for overflow, pull-based `YieldSnapshot` per epoch, ERC-3643 modular compliance topology (`MuHavenIdentityRegistry` + `ModularCompliance` + module library), and the `MuHavenStable` confidential USDC wrapper (mhUSDC) replacing legacy PUSDC for MuHaven flows. fhERC-20 balances, ZeroDev passkey kernel + scoped session keys, backend + FHE worker + NAV worker + NAV publisher on a Cloudflare tunnel. TBILL1 + GOLD1 onboarded end-to-end. Investors and issuers drive every flow directly from the Vue 3 dashboard today; self-serve issuer onboarding wizard ships per-token contracts on-chain in one transaction batch. The **AI agent layer is in active development on a parallel branch** (HavenBot in-dashboard copilot, `@muhaven/mcp` MCPB server, OpenClaw skill, hosted checkout at `muhaven.app/pay`, tiered-autonomy engine) — see [AI Agent Design](./docs/AGENT_DESIGN.md).

**How it works in 30 seconds:**

1. An **issuer** onboards a tokenized RWA through the self-serve wizard — a single transaction batch deploys per-token `MuHavenToken` (fhERC-20), `MuHavenTreasury`, and `RedemptionQueue` proxies, registers the token in `TokenRegistry`, and binds compliance modules (`CountryAllow`, `MaxHolders`, `Lockup`, …). NAV is set via `IssuerControlledOracle` (or Chainlink Functions for treasury/gold).
2. An **investor** signs in with a passkey (ZeroDev kernel), wraps USDC into the confidential `MuHavenStable` wrapper (mhUSDC), and calls `MuHavenSubscription.purchase(token, encAmount, maxSharesHint, eph)` — atomic single-tx KYC gate → compliance modules → oracle read → `FHE.mul` → mhUSDC pull → mint → `FHE.allow` to the ephemeral session signer. Encrypted balances from the first share onward.
3. When the issuer distributes yield, the SDK drives `YieldSnapshot.openEpoch` → `snapshotBatch` → `finalizeSnapshot` → `fundEpoch`. Per-investor share is computed once at fund time as a fixed-point `ratePerShare`; investors pull their own share on their own schedule via `claimYield(epochId, eph)`. The issuer sees aggregate epoch totals, not individual shares.
4. The investor claims from the dashboard — a gasless UserOp through their ZeroDev kernel + scoped session key (most subsequent actions silent, no passkey prompt). Silent-fail on bad conditions means an observer can't tell a failed claim from a real one.
5. The agent layer sits on top of this pipeline as a natural-language front-end (HavenBot chat, `@muhaven/mcp` MCP server, OpenClaw skill, hosted checkout) — but the privacy guarantees live in the contracts and SDK, so they don't depend on the agent being present.

### Three merged problems, one product

MuHaven solves three RWA issues simultaneously — because solving them separately would be architecturally incomplete:

| Issue | Why it's inseparable | How MuHaven solves it |
|-------|---------------------|----------------------|
| **Balance privacy** | The core problem — holdings visible to everyone | fhERC-20 tokens with FHE-encrypted balances via Fhenix CoFHE |
| **Yield distribution privacy** | Yields leak balance info — breaks balance privacy | Pull-based `YieldSnapshot` — encrypted per-investor share, fixed-point `ratePerShare` per epoch, payouts settled in mhUSDC ciphertext via `MuHavenStable.trustedPayout` fast-path |
| **Encrypted settlement currency** | Cleartext USDC defeats balance privacy | `MuHavenStable` (mhUSDC) — own confidential USDC wrapper with `_silentFailBound` semantics, replaces legacy PUSDC for all MuHaven flows |
| **KYC-gated access + jurisdictional rules** | Securities require investor verification + per-token rule sets | ERC-3643 topology: `MuHavenIdentityRegistry` (claim verification + dev-mode flag) + `ModularCompliance` + module library (`CountryAllow`, `CountryRestrict`, `MaxHolders`, `Lockup`, `MaxBalance`) |

### The AI agent: three hats, one conversation

<img src="./docs/images/agent-flow.jpg" alt="Agent flow" width="850" />

The AI agent isn't a chatbot. It's three roles in one:

- **Advisor** — Asks questions, assesses risk tolerance, recommends allocations based on available RWA yields.
- **Risk manager** — Converts investor preferences into on-chain guardrails (max drawdown, min yield threshold, drift tolerance) — all encrypted.
- **Executor** — Deposits, allocates, claims yields, rebalances — all on encrypted state, within bounds the investor approved.

The agent never holds a key. It reuses the investor's ZeroDev kernel through `@zerodev/permissions` validators (`CallPolicy` + `GasPolicy` + `RateLimitPolicy`) — per-target selector allowlist, value cap per call, total cap per epoch, validity ≤ chat session. A deterministic policy gate sits between the LLM and the signing path (CaMeL planner/action split) so prompt injection cannot reach permission-grant or tx-submission surfaces. Tiered-autonomy state machine lets the investor opt between Advisory, Confirm-per-action, and Policy-bound modes; `/pause` kill-switch uninstalls the active session validator in a single transaction.

---

## Architecture

<img src="./docs/images/architecture-overview.jpg" alt="Architecture" width="850" />

### System layers

MuHaven is a **two-sided platform** — issuers create and manage RWA tokens on the supply side, investors purchase and manage portfolios on the demand side. Both sides share the same smart contracts.

```
┌────────────────────────────────────────────────────────────────────┐
│  ISSUER SIDE (supply)                    INVESTOR SIDE (demand)    │
│                                                                    │
│  ┌──────────────────────┐                 ┌────────────────────┐   │
│  │ Issuer Dashboard     │                 │ Investor Dashboard │   │
│  │ - Onboard token      │                 │ - Wrap → mhUSDC    │   │
│  │   (self-serve wizard)│                 │ - Buy / Redeem     │   │
│  │ - Set NAV (oracle)   │                 │ - Claim yield      │   │
│  │ - Run yield epoch    │                 │ - Set risk policy  │   │
│  │ - Manage compliance  │                 │ + HavenBot chat    │   │
│  └──────────┬───────────┘                 └─────────┬──────────┘   │
│             │                                       │              │
│             ▼                                       ▼              │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                   MuHaven Platform Contracts                 │  │
│  │                                                              │  │
│  │  MuHavenSubscription ──atomic──→ MuHavenToken (fhERC-20)     │  │
│  │      │ purchase / redeem        ↑ mintFromSubscription       │  │
│  │      ▼                          ↓ burnFromSubscription       │  │
│  │  MuHavenTreasury (per-token mhUSDC custody)                  │  │
│  │      ↑                                                       │  │
│  │      │  IPriceOracle ──→ IssuerControlledOracle              │  │
│  │      │                  + ChainlinkFunctionsOracle           │  │
│  │      │                                                       │  │
│  │  RedemptionQueue (overflow + epoch settlement)               │  │
│  │  YieldSnapshot   (pull-based, ratePerShare per epoch)        │  │
│  │                                                              │  │
│  │  TokenRegistry · InvestorRegistry · MuHavenIdentityRegistry  │  │
│  │  ModularCompliance ──→ CountryAllow / MaxHolders / Lockup …  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              │                                     │
│                              ▼                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  MuHavenStable (mhUSDC, own confidential USDC wrapper)       │  │
│  │  + Fhenix CoFHE (FHE) on Arbitrum Sepolia                    │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

> See [ARCHITECTURE.md](./docs/ARCHITECTURE.md) for detailed technical architecture and data flow diagrams.

### Smart contracts

The production deploy ships **11 platform contracts** (singleton, behind transparent proxies) plus a **per-token contract triple** deployed by the issuer onboarding wizard for every listed RWA. Wave 3 contracts (`MuHavenVault` / `YieldDistributor` / `MuHavenEscrow` / `YieldGate` / `ERC3643KYCAdapter`) are retired into a read-only window and superseded by the contracts below.

**Platform (singleton):**

| Contract | Purpose |
|----------|---------|
| `MuHavenStable.sol` | Confidential USDC wrapper (mhUSDC). Replaces legacy PUSDC for all MuHaven flows. `_silentFailBound` semantics, `trustedPayout` fast-path for known-conservation callers (escrow / snapshot / distributor) |
| `MuHavenSubscription.sol` | **Atomic single-tx buy/redeem coordinator.** KYC gate → compliance modules → oracle read → `FHE.mul` → mhUSDC pull → mint (or burn → mhUSDC pay-out). Ephemeral-EOA `FHE.allow` per ADR-021 |
| `TokenRegistry.sol` | Per-token configuration registry — issuer, oracle binding, treasury / queue / snapshot pointers, paused flag, schedule metadata |
| `InvestorRegistry.sol` | Per-token holder enumeration; `addHolder` called by `MuHavenToken._transfer` on first transfer-in |
| `MuHavenIdentityRegistry.sol` | ERC-3643 identity registry. `isVerified()` runs whitelist → claim verification (topics × trusted issuers × `validUntil`); `devMode` flag for migration; `disableDevModeForever()` irreversible latch |
| `ClaimTopicsRegistry.sol`, `TrustedIssuersRegistry.sol` | ERC-3643 auxiliary registries |
| `ModularCompliance.sol` | Per-token rule-modules registry. `canTransfer` AND-aggregates active modules with short-circuit; state hooks on mint / transfer / burn |
| `IssuerControlledOracle.sol` | Pluggable `IPriceOracle` reference impl — issuer-write NAV with per-token `navWriter` rotation, configurable staleness window, deviation gate (per-token `maxDeviationBps`, pending state on gate failure), L2 sequencer-uptime check via Chainlink-shaped feed |
| `ChainlinkFunctionsOracle.sol` | Functions-backed `IPriceOracle` — pulls FRED `DGS3MO` for treasury bills, FRED `GOLDPMGBD228NLBM` (or metals-api fallback) for gold; per-token `navRequester` hot key |
| `RiskParams.sol` | Encrypted investor risk guardrails (`euint64`) — max drawdown, min yield, drift tolerance, max daily spend; branchless `FHE.select` hot path planned for the policy engine |

**Per-token (deployed by the issuer onboarding wizard):**

| Contract | Purpose |
|----------|---------|
| `MuHavenToken.sol` | fhERC-20 RWA token (`euint128`). Issuer no longer holds `MINTER_ROLE` — only `MuHavenSubscription` (via `SUBSCRIPTION_ROLE`) and `RedemptionQueue` (via `burnFromQueue`) can mutate supply. `transfer` / `transferFrom` call `InvestorRegistry.addHolder` on first-transfer-in |
| `MuHavenTreasury.sol` | Per-token mhUSDC custody. Immutable operator approvals to Subscription + Queue at init; `minFloat` solvency floor enforced via silent-fail `FHE.select` |
| `RedemptionQueue.sol` | Overflow redemption queue. `submit` captures `ephemeralEOA` + `maxSharesHint`; `processEpoch` settles requests at issuer-published NAV; `claim` pays from treasury; `cancelOnKYCRevocation` returns shares |
| `YieldSnapshot.sol` | Pull-based per-epoch yield distribution (replaces push-based `YieldDistributor`). `openEpoch` → paginated `snapshotBatch` (idempotent, accumulates `encTotalSupply`) → `finalizeSnapshot` → `fundEpoch` (issuer pulls mhUSDC, stores cleartext fixed-point `ratePerShare`) → `claimYield(epochId, eph)` (pull-based, idempotent, `FHE.mul` × `RATE_SCALE` div for sub-1:1 yields, payout via `MuHavenStable.trustedPayout`) |

**Compliance modules (pluggable via `ModularCompliance`):**

| Module | Purpose |
|---|---|
| `CountryAllow`, `CountryRestrict` | Per-token ISO-3166 allow / block lists |
| `MaxHolders` | Cap holder count via `InvestorRegistry`; separate accredited / non-accredited counters |
| `Lockup` | Per-token default lockup window applied on mint + transfer-in; mint always allowed |
| `MaxBalance` | Cleartext upper-bound tracker fed from `maxSharesHint` (loose by ADR-019) |

> See [SMART_CONTRACTS.md](./docs/SMART_CONTRACTS.md) for full contract specifications, EIP compliance mapping, and ADR cross-references.

### Deployed contracts (Arbitrum Sepolia · production)

All contracts are verified on [Arbiscan](https://sepolia.arbiscan.io). Proxied contracts use OpenZeppelin Transparent Proxy. Addresses mirror [`deployments/arb-sepolia-v2.json`](./deployments/arb-sepolia-v2.json) (authoritative — fresh deploy 2026-05-04, deployer `0xe11E…6986`).

**Platform (singleton):**

| Contract | Address | Type |
|----------|---------|------|
| MuHavenStable (mhUSDC) | [`0xF9bc25b67238C870255c33EC75fA37A09C00edE7`](https://sepolia.arbiscan.io/address/0xF9bc25b67238C870255c33EC75fA37A09C00edE7) | proxy |
| MuHavenSubscription | [`0x39D49B2614d24ba189B613bEAa903d829A73eA9e`](https://sepolia.arbiscan.io/address/0x39D49B2614d24ba189B613bEAa903d829A73eA9e) | proxy |
| TokenRegistry | [`0x4915E9Aa034244e299fb1609792D66b9fFAbf885`](https://sepolia.arbiscan.io/address/0x4915E9Aa034244e299fb1609792D66b9fFAbf885) | proxy |
| InvestorRegistry | [`0xE7D4CB42EdB19e268e5e8a10d1A02f321Bfa50D0`](https://sepolia.arbiscan.io/address/0xE7D4CB42EdB19e268e5e8a10d1A02f321Bfa50D0) | proxy |
| MuHavenIdentityRegistry | [`0xD9Ab61fdED044bcBeB9eF687C357A35B5E7E9fAD`](https://sepolia.arbiscan.io/address/0xD9Ab61fdED044bcBeB9eF687C357A35B5E7E9fAD) | proxy |
| ClaimTopicsRegistry | [`0x56Cb047ddCd07aD8217BE54Dd7703D9125D704d4`](https://sepolia.arbiscan.io/address/0x56Cb047ddCd07aD8217BE54Dd7703D9125D704d4) | proxy |
| TrustedIssuersRegistry | [`0x4587F75d0bCa84c8C944698b4e23Cb657E8D31B1`](https://sepolia.arbiscan.io/address/0x4587F75d0bCa84c8C944698b4e23Cb657E8D31B1) | proxy |
| ModularCompliance | [`0x9A190A310C23FcF9Cd6c5Eab26Eb624B89e4D07a`](https://sepolia.arbiscan.io/address/0x9A190A310C23FcF9Cd6c5Eab26Eb624B89e4D07a) | proxy |
| YieldSnapshot | [`0xaC4163f84db2C85333D5aF6f87848d7362A59887`](https://sepolia.arbiscan.io/address/0xaC4163f84db2C85333D5aF6f87848d7362A59887) | proxy |
| IssuerControlledOracle | [`0xD30069114dFC83C714B04d6036dEfa64d2E9d583`](https://sepolia.arbiscan.io/address/0xD30069114dFC83C714B04d6036dEfa64d2E9d583) | proxy |
| ChainlinkFunctionsOracle | [`0x6a480c6F7553098f7B9b0b285EcB7207a93feC43`](https://sepolia.arbiscan.io/address/0x6a480c6F7553098f7B9b0b285EcB7207a93feC43) | proxy |

**Onboarded tokens (per-token contracts):**

| Token | MuHavenToken | MuHavenTreasury | RedemptionQueue |
|-------|--------------|------------------|-----------------|
| TBILL1 (Treasury Bill Series 1) | [`0x8D77cCf0a3a56c976a7DEAe59aF1D27f27407b0D`](https://sepolia.arbiscan.io/address/0x8D77cCf0a3a56c976a7DEAe59aF1D27f27407b0D) | [`0xf423CE2d1fD856F89Ca75ec47c2791CeD91D62a3`](https://sepolia.arbiscan.io/address/0xf423CE2d1fD856F89Ca75ec47c2791CeD91D62a3) | [`0x435aF5AF238aBe80DD4dc571C38C167F407c4E9c`](https://sepolia.arbiscan.io/address/0x435aF5AF238aBe80DD4dc571C38C167F407c4E9c) |
| GOLD1 (Gold Series 1) | [`0x93e813e924A96441181A01171Cd1E20FaaC87AcF`](https://sepolia.arbiscan.io/address/0x93e813e924A96441181A01171Cd1E20FaaC87AcF) | [`0x5057b445d7Ac1AFbd834122f63A9652DfCb78157`](https://sepolia.arbiscan.io/address/0x5057b445d7Ac1AFbd834122f63A9652DfCb78157) | [`0x6f2D952c0350BB0d5F856df5F7f534dEAD6634A7`](https://sepolia.arbiscan.io/address/0x6f2D952c0350BB0d5F856df5F7f534dEAD6634A7) |

**External (Arb Sepolia):**

| Contract | Address |
|----------|---------|
| Circle USDC | [`0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`](https://sepolia.arbiscan.io/address/0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d) |
| Legacy ConfidentialUSDC (PUSDC, retired in MuHaven flows) | [`0x6b6e6479b8b3237933c3ab9d8be969862d4ed89f`](https://sepolia.arbiscan.io/address/0x6b6e6479b8b3237933c3ab9d8be969862d4ed89f) |
| Chainlink Functions Router | [`0x234a5fb5Bd614a7AA2FfAB244D603abFA0Ac5C5C`](https://sepolia.arbiscan.io/address/0x234a5fb5Bd614a7AA2FfAB244D603abFA0Ac5C5C) |

> Full deployment data: [`deployments/arb-sepolia-v2.json`](./deployments/arb-sepolia-v2.json) · Wave 3 read-only artifact: [`deployments/arb-sepolia.json`](./deployments/arb-sepolia.json)

### Backend services

A 5-service Docker stack runs on a homelab behind a Cloudflare tunnel. Production at `api.muhaven.app` (master branch); staging at `api-stage.muhaven.app` (agenticwave branch) — both stacks isolated, side-by-side, never share Postgres.

| Service | Role |
|---------|------|
| `postgres:16` | Drizzle schema store — users, sessions, RWA tokens, holdings, epochs, queue requests, NAV history, audit log |
| `backend` | REST API — passkey auth (ZeroDev kernel link + JWT), portfolio aggregation, issuer onboarding, yield + redemption queries, NAV writer endpoints, webhook ingest, agent chat stub |
| `fhe-worker` | Server-side CoFHE encryption via `@cofhe/sdk/node` (isolated from the API pod) |
| `nav-worker` | Periodic NAV fetcher — FRED treasury yields, on-chain oracles, source-audit-trail with fallbacks |
| `nav-publisher` | On-chain NAV writer — pulls fresh values from `nav-worker` and pushes to `IssuerControlledOracle` per token, gated by deviation + sequencer-uptime checks |

Deploy is a single command from the dev machine:

```bash
pnpm run deploy:homelab          # prod  · master       → api.muhaven.app
pnpm run deploy:homelab:stage    # stage · agenticwave  → api-stage.muhaven.app
```

Both wrap `scripts/deploy-homelab.sh <env>`. Branch-guarded (master for prod, develop for stage) and always passes `-f` + `-p` so the two compose stacks (`docker-compose.yml` / `muhaven` vs `docker-compose.stage.yml` / `muhaven-stage`) stay physically isolated. Downtime is ~3–5s per restarted service; postgres is never touched.

Setup details, env-var tables, Cloudflare tunnel config, and migration commands: [BACKEND_SETUP.md](./docs/BACKEND_SETUP.md).

### MuHaven SDK

`@muhaven/sdk` (TypeScript, `packages/sdk/`) wraps the production pipeline behind a single `MuHavenClient` plus per-contract clients (`SubscriptionClient`, `TreasuryClient`, `RedemptionQueueClient`, `YieldSnapshotClient`, `OracleClient`):

```typescript
const sdk = new MuHavenClient({ publicClient, sender, cofheClient, addresses });

// Investor — atomic buy / pull-based claim
await sdk.subscription.purchase(token, encAmount, maxSharesHint, eph);
await sdk.snapshot.claimYield(token, epochId, eph);

// Issuer — pull-based yield epoch
await sdk.snapshot.openEpoch(token);
await sdk.snapshot.snapshotBatch(token, epochId, holders);
await sdk.snapshot.finalizeSnapshot(token, epochId);
await sdk.snapshot.fundEpoch(token, epochId, totalYield, ratePerShare);
```

Pluggable sender pattern (`walletClientToSender` for EOA/scripts, `createZeroDevSender` for the browser kernel + session keys) means the same API drives both the Vue frontend and backend workers. 25 integration tests covering the full pipeline. Full API reference: [SDK.md](./docs/SDK.md).

### Token lifecycle

Every RWA token on MuHaven moves through a four-state lifecycle — **Active → Paused → Winding Down → Archived** — governing minting, transfers, distributions, and investor redemption at each stage. The contract + backend hooks are in place in Wave 3; full implementation lands post-hackathon. Full spec: [TOKEN_LIFECYCLE.md](./docs/TOKEN_LIFECYCLE.md).

### AI agent layer (Wave 4 — in active development)

> **Status:** the chat scaffold and tool schemas shipped with the production cutover. The full agentic execution loop is in active development on a parallel branch (~203h of ~327h shipped: tiered-autonomy engine, MCPB server + broker daemon, OpenClaw skill + Telegram surface, hosted checkout, encrypted policy primitives, DefaultProtection + EncryptedGovernance + KYC attestation stubs). It awaits the production cutover settlement before it merges back to develop. Investors and issuers can drive every flow directly from the Vue dashboard today.

**Four agentic surfaces** sit on the same MuHaven SDK + `@zerodev/permissions` policy gate:

| Surface | Description | Status |
|---|---|---|
| **HavenBot** | In-dashboard streaming chat at `/agent`. Per-action confirm modals with FHE-decrypted preview. Onboarding flow targets <6 min passkey → KYC → first-buy | scaffold shipped (chat UI + stub); execution loop in Wave 4 P2 |
| **`@muhaven/mcp` MCPB server** | Local MCP server with `manifest.json` declaring secrets `sensitive: true` → OS keychain. Companion `muhaven-broker` daemon over Unix socket holds session-key private half. Toolsets: `muhaven.read.*`, `muhaven.position.*`, `muhaven.policy.*` | shipped on parallel branch (Wave 4 P3) |
| **OpenClaw skill** | `muhaven-rwa-skill` published to ClawHub via Sigstore + GitHub OIDC. Bundles a subset of the MCP toolset. Telegram surface with three confirmation tiers (inline ≤$200, Mini App + 6-digit OTP $200–$5K, deep-link passkey >$5K). A2A Agent Card for VibeKit / Google ADK discovery | shipped on parallel branch (Wave 4 P4) |
| **Hosted checkout `muhaven.app/pay`** | Stripe-pattern hosted-checkout URL `muhaven.app/pay/c/<ulid>#k=<base64url(32B)>`. AES-256-GCM enc_payload with key in URL fragment (server cannot read alone). HMAC-SHA256 webhook signing, 5-min replay window. SSE realtime status. ZeroDev passkey ceremony for first-time buyers | shipped on parallel branch (Wave 4 P5) |

**Tool catalog** (executed via the deterministic policy gate, never by the LLM directly):

| Tool | What it does | Underlying |
|------|-------------|-----------|
| `muhaven_portfolio_summary` | Encrypted balance preview + `ebool` signal flags (`isOverexposed`, `isUnderYield`) | CoFHE `decryptForView` + permit |
| `muhaven_quote(asset, amount)` | Cleartext NAV × amount preview before purchase | `IPriceOracle.getNAV` |
| `muhaven_propose_buy` | Atomic purchase via `MuHavenSubscription.purchase` | MuHaven SDK |
| `muhaven_propose_redeem` | Instant redeem with auto-escalate on cap overflow | MuHavenSubscription + RedemptionQueue |
| `muhaven_propose_claim` | Pull yield for a finalized epoch | YieldSnapshot |
| `muhaven_set_policy(tier, params)` | Tiered-autonomy state machine (Advisory / Confirm / Policy-bound) | `@zerodev/permissions` validators + RiskParams |
| `muhaven_pause` | Single-tx kill-switch; uninstalls active session validator | ZeroDev kernel |
| `muhaven_unseal_position(handle, permit)` | Permit-based decrypt of a specific handle | CoFHE `decryptForView` |
| `muhaven_check_protection_coverage` | Read public `reserveRateBps` from DefaultProtection | DefaultProtection (Wave 4 P11) |
| `muhaven_propose_governance_vote`, `muhaven_cast_encrypted_vote` | Encrypted ballot via `FHE.select` + async tally | EncryptedGovernance (Wave 4 P11) |

**Issuer-facing** tools cover token onboarding, NAV writes, snapshot + fund-epoch wizard, KYC whitelist, audit copilot — folded into the same agent surfaces.

> See [AGENT_DESIGN.md](./docs/AGENT_DESIGN.md) for staged rollout, wallet model (kernel + scoped session keys, no separate agent wallet), tiered-autonomy state machine, threat model, and full design spec.

---

## Privacy Boundary

MuHaven's privacy guarantee is **balance and yield privacy** — not transaction graph privacy. The table below documents exactly what is encrypted vs. public, and why.

| Data | Visibility | Rationale |
|------|-----------|-----------|
| **Investor balances** | **Encrypted** (`euint128`) | Core privacy guarantee. Only the investor can decrypt via EIP-712 permit. |
| **Transfer amounts** | **Encrypted** (`InEuint128`) | Client-encrypts before submission. Calldata contains ciphertext hash + ZK proof, never plaintext. |
| **Yield per investor** | **Encrypted** (`euint128`) | Each investor's share is FHE-encrypted. Investors decrypt their own share via permits. |
| **Total yield deposited per epoch** | **Encrypted** (`euint128`) | Yield is deposited via encrypted mhUSDC `transferFrom` — no cleartext amounts on-chain for the encrypted leg. |
| **Risk parameters** | **Encrypted** (4× `euint64`) | Investor-encrypted client-side. Branchless `FHE.select` hot path; breach-only async decrypt preserves no-decrypt-timing privacy. |
| **Total supply** | **Encrypted** (default) / **Public** (opt-in) | Issuer can toggle `setTotalSupplyPublic()` — one-way, uses `FHE.allowPublic`. Useful for regulated securities requiring public supply. |
| **Aggregate yield distributed per epoch** | **Encrypted** (`euint128`) | Running total per epoch. Issuer can async-decrypt for reporting via permit-based grant. |
| **Per-epoch `ratePerShare`** | **Cleartext (`uint128`)** | By design — for RWAs the per-share yield rate (TBILL APY, dividend rate) is conventionally published off-chain anyway. Per-investor balances and per-claim shares stay encrypted; this scalar is what made the cleartext rate architecture (Wave 3.5) escape the cofhe TN chain-length cap. Conservation enforced off-chain by the issuer. |
| Investor addresses | Public | Stored in InvestorRegistry. Addresses are inherently public on EVM (visible in tx calldata). |
| Transfer from/to addresses | Public | Emitted in `Transfer(from, to)` event. No new info leaked — addresses already visible in calldata. |
| KYC eligibility | Public | Boolean per address. Revert on `isVerified()==false` is observable, but no private data leaks. |
| Transaction timing | Public | Block timestamps visible on-chain. |
| Issuer / SUBSCRIPTION_ROLE / navWriter roles | Public | Role assignments emitted in events. |
| Snapshot + redemption progress | Public | `epochId`, `holderCount`, `processedCount`, `requestId` are cleartext counters for batch progress tracking. |

### Side-channel resistance

All `FHE.select()` operations execute an **identical code path** regardless of the encrypted condition result:

```solidity
// Transfer: same gas cost whether balance is sufficient or not
euint128 transferAmount = FHE.select(hasEnough, amount, zero);
```

An observer watching gas costs or execution traces cannot distinguish a successful transfer from a failed (zero-amount) one. This is the "silent failure" pattern applied consistently across `MuHavenToken`, `MuHavenStable`, `MuHavenSubscription`, `MuHavenTreasury`, `RedemptionQueue`, and `YieldSnapshot` — every contract that moves or transforms encrypted amounts on behalf of an investor returns a silent-fail-bounded handle (ADR-030 + ADR-036 conventions).

### FHE operations used

| Operation | Where | Purpose |
|-----------|-------|---------|
| `FHE.asEuint128(InEuint128)` | Token, Subscription, Queue, Snapshot | Convert client-encrypted input to on-chain ciphertext |
| `FHE.asEuint128(uint256)` | Token, Snapshot | Trivial encrypt cleartext for on-chain computation (e.g. `RATE_SCALE` for sub-1:1 yields) |
| `FHE.add` | Token, Snapshot | Balance increment, snapshot supply accumulation |
| `FHE.sub` | Token, Stable | Balance decrement |
| `FHE.mul` | Subscription, Snapshot | NAV × amount on purchase / redeem; `balance × ratePerShare` on claim |
| `FHE.div` | Snapshot | `RATE_SCALE` rescale on claim payout (sub-1:1 yields) |
| `FHE.gte`, `FHE.lte` | Token, Stable, Treasury | Balance sufficiency / solvency-floor checks (returns `ebool`) |
| `FHE.select` | Token, Stable, Subscription, Treasury, Queue | Silent failure — branchless conditional zero |
| `FHE.allow(ct, address)` | Token, Subscription, Queue, Snapshot, RiskParams, Stable | Grant permit-based `decryptForView` to ephemeralEOA per ADR-021 |
| `FHE.allowThis` | All contracts | Contract retains access to its own ciphertext handles |
| `FHE.allowSender` | RiskParams | Investor retains read access to own risk params |
| `FHE.allowPublic` | Token | Optional public total supply via threshold decryption |
| `Common.isInitialized` | Token, Stable, Subscription | Guard against FHE ops on uninitialized (zero-hash) ciphertext |
| `ITaskManager.createDecryptTask` | Token, RiskParams, Snapshot | Async decrypt for on-chain result reading |
| `FHE.getDecryptResultSafe` | Token, RiskParams, Snapshot | Read async-decrypted plaintext result |

> Full threat model: [THREAT_MODEL.md](./docs/THREAT_MODEL.md)

---

## Why Fhenix + ReineiraOS

### Why FHE, not just ZK?

| Capability | ZK proofs | FHE (Fhenix) |
|-----------|-----------|---------------|
| Prove a fact without revealing it | Yes | Yes |
| Encrypt balances as persistent on-chain state | No | **Yes** |
| Compute on encrypted data (transfers, yields) | No | **Yes** |
| Ongoing encrypted state management | No | **Yes** |
| Binary verification (accredited? yes/no) | Yes | Yes |
| Tiered computation (which tranche? how much yield?) | No | **Yes** |

ZK proves things about data. FHE computes on data. RWAs need ongoing computation on sensitive state — that's the whitespace FHE fills.

### Why Fhenix specifically?

- **CoFHE coprocessor** — Offloads heavy FHE computation off-chain, verified on-chain. 50x faster decryption than competitors.
- **fhERC-20 standard** — Production-ready encrypted token standard with encrypted balances and transfers.
- **Solidity-native** — Standard Solidity + Hardhat workflow. Import the library, use encrypted types. No new language.
- **Live on Arbitrum** — CoFHE is deployed on Arbitrum, not just testnet.
- **Quantum-resistant** — Lattice-based cryptography, resistant to quantum attacks.

### Why ReineiraOS?

ReineiraOS is programmable infrastructure for stablecoins, built on Arbitrum and powered by Fhenix FHE. MuHaven was scaffolded from the ReineiraOS Platform Modules starter and originally settled in ReineiraOS PUSDC + `ConfidentialEscrow`. The production pipeline now ships its own `MuHavenStable` (mhUSDC) wrapper after PUSDC's pre-v0.1.0 `euint64` selector mismatch surfaced; MuHaven flows still benefit from the wider ReineiraOS surface area and the shared CoFHE coprocessor.

- **Platform Modules** — Plug-and-play backend (Clean Architecture, DB-agnostic) and app starter (ZeroDev smart accounts, passkey auth) — the substrate MuHaven's `backend/` is built on.
- **`MuHavenStable` (mhUSDC)** — own FHE-encrypted USDC wrapper layered on top of legacy ReineiraOS PUSDC. Inherits PUSDC's confidential transfer semantics, adds `_silentFailBound` returns + `trustedPayout` fast-path for known-conservation callers (escrow / snapshot / distributor) — see [SMART_CONTRACTS.md](./docs/SMART_CONTRACTS.md).
- **Cross-chain settlement** — Circle CCTP V2 integration is on the post-Wave-4 roadmap for fiat on-ramp surfaces.
- **Same CoFHE coprocessor** — Zero integration friction between MuHaven's token contracts and any future ReineiraOS modules MuHaven re-adopts.

---

## Competitive Positioning

### The "Confidential DeFAI" quadrant — MuHaven is alone here

<img src="./docs/images/competitive-matrix.jpg" alt="Competitive Positioning" width="850" />

|  | Transparent state | Encrypted state |
|--|-------------------|-----------------|
| **AI-managed** | Virtuals, SingularityDAO, Theoriq | **MuHaven** (only player) |
| **Manual** | Securitize, Ondo, Centrifuge | Canton, Silent Data, Inco/Zama |

Every existing DeFAI agent operates on transparent state — strategies are visible and exploitable. Every existing privacy solution is manual — no AI portfolio management. MuHaven is the only product that combines both.

> Full competitive breakdown: [COMPETITIVE_ANALYSIS.md](./docs/COMPETITIVE_ANALYSIS.md)

### MuHaven vs. the landscape

| Feature | Permissioned chains (Canton, Silent Data) | ZK identity (zkMe, Polygon ID) | Existing DeFAI (Virtuals, SingularityDAO) | **MuHaven** |
|---------|------------------------------------------|-------------------------------|------------------------------------------|-------------|
| Balance privacy | Via access control | No | No | **FHE-encrypted on-chain** |
| Yield privacy | Via access control | No | No | **Encrypted escrow** |
| Issuer sees individual positions | Yes | N/A | N/A | **No — only aggregates** |
| Token issuance (native + wrapped) | Custom | No | No | **Yes (fhERC-20 + vault wrapper)** |
| DeFi composability | No (siloed) | Yes | Yes | **Yes** |
| AI portfolio management | No | No | Yes (transparent) | **Yes (encrypted)** |
| Compliance-ready | Yes | Yes | No | **Yes (modular gate)** |
| Cross-chain | Limited | Yes | Varies | **Yes (CCTP V2)** |
| MEV protection | Via permissioning | No | No | **Structural (encrypted state)** |

---

## Market opportunity

### The numbers

| Metric | Value | Source |
|--------|-------|--------|
| Tokenized RWAs on-chain | **$29B+** (Sep 2025) | RWA.xyz |
| On-chain RWA holders | **385,000+** | RWA.xyz |
| Projected RWA market (2030) | **$30 trillion** | Security Token Market |
| Tokenized US Treasuries | **$7.4B** (mid-2025, +80% YTD) | Zoniqx |
| Private DeFi channels Q3 2025 | **$2.3B** | Fhenix research |
| DeFAI market projection (2034) | **$47B** (28.9% CAGR) | CV VC |
| Fortune 500 using AI agents | **80%** (Feb 2026) | Microsoft |

### Consumer market (end-user investors)

- **385,000+ on-chain RWA holders** today — every one has publicly exposed balances.
- **$29B+ tokenized RWAs** on-chain as of September 2025, projected to reach $600B by end of 2025.
- **$2.3B in private DeFi channels** in Q3 2025 alone — institutional traders already seeking confidential execution.
- **DeFAI market** projected to reach $47B by 2034, growing at 28.9% CAGR.

### Business market (RWA issuers and platforms)

- **274 RWA issuers** actively tokenizing assets — each needs a privacy layer for institutional adoption.
- **Tokenized treasuries** alone surpassed $7.4B by mid-2025, up 80% year-to-date.
- **Major institutions** (BlackRock BUIDL, Franklin Templeton BENJI, JPMorgan) all cite confidentiality as a prerequisite for scaling.
- MuHaven's **issuer model** supports both wrapped tokens (existing ERC-20 RWAs) and native issuance — see [ISSUER_MODEL.md](./docs/ISSUER_MODEL.md) for the full supply-side design.

### Why now?

- Fhenix CoFHE is live on Arbitrum (infrastructure exists).
- ERC-3643 was presented to the SEC Crypto Task Force (regulatory alignment).
- 80% of Fortune 500 now deploy active AI agents (agentic AI is mainstream).
- x402 payment protocol launched (agent-to-agent payments are real).

---

### Roadmap

**In active Wave 4 development (~203h of ~327h shipped on a parallel branch, awaits production cutover settlement before merge):**

- Tiered-autonomy engine + audit log + `/pause` kill-switch (Advisory / Confirm-per-action / Policy-bound state machine)
- HavenBot in-dashboard streaming chat with per-action confirm modals
- `@muhaven/mcp` MCPB server + `muhaven-broker` daemon (OS-keychain credentials, Unix-socket signing)
- OpenClaw skill `muhaven-rwa-skill` (Sigstore + GitHub OIDC trusted publishing) + Telegram surface with three confirmation tiers
- Hosted checkout `muhaven.app/pay` (Stripe-pattern URL, AES-256-GCM enc_payload, HMAC-SHA256 webhooks, ZeroDev passkey ceremony for first-time buyers)
- Encrypted policy primitives in `RiskParams` (branchless `FHE.select` hot path, breach-only async decrypt, investor-signed permit scoping)
- DefaultProtection + EncryptedGovernance + KYC attestation stub contracts

**Post-Wave 4:**

- Native token issuance (without vault wrap) — research
- Stealth addresses (ERC-5564 / ERC-6538) for deposit-side privacy
- Cross-chain KYC full implementation (CCIP revocation broadcast)
- Revenue model activation: wrapping fee (0.1%), issuance fee (0.2%), yield distribution fee (0.1%) — see [ISSUER_MODEL.md](./docs/ISSUER_MODEL.md)
- Multi-chain expansion beyond Arbitrum (Base, Ethereum L1)
- Production security audit
- Mainnet deployment (Arbitrum One)

---

## Tech Stack

| Layer | Technology | Version  |
|-------|-----------|----------|
| Blockchain | Arbitrum Sepolia (testnet) → Arbitrum One (production) | —        |
| FHE contracts | `@fhenixprotocol/cofhe-contracts` | `v0.1.3` |
| FHE client SDK | `@cofhe/sdk` + `@cofhe/hardhat-plugin` + `@cofhe/mock-contracts` | `v0.5.1` |
| FHE runtime | `tfhe` (frontend) | `v1.5.3` |
| Dev starter | `cofhe-hardhat-starter` (branch: `sdk-migration`) | —        |
| Token standard | fhERC-20 (max type: `euint128`) | —        |
| KYC / compliance | ERC-3643 — `MuHavenIdentityRegistry` + `ModularCompliance` topology with pluggable rule modules | —     |
| Confidential settlement | `MuHavenStable` — own confidential USDC wrapper (mhUSDC) with `_silentFailBound` semantics | —     |
| Smart account | ZeroDev Kernel (ERC-4337) + WebAuthn passkey + `@zerodev/permissions` session keys | —        |
| Backend | Node 20 + tsx (Clean Architecture from ReineiraOS Platform Modules), Drizzle + Postgres, Docker Compose, Cloudflare tunnel | —     |
| Cross-chain | Circle CCTP V2 (planned for fiat on-ramp surfaces) | —        |
| Frontend | Vue 3 + Vite + Bun + Tailwind CSS v4 (in-progress Golden Hour Midnight revamp) | —        |
| AI agent | Anthropic Claude Sonnet 4.5 via Vercel AI SDK (HavenBot); host-LLM-agnostic for MCP / OpenClaw | —     |
| Package manager | pnpm (Fhenix recommended) | v9+      |

> **SDK stability warning**: Fhenix `cofhe-contracts` is under active development. The team warns it "will be changing frequently." MuHaven contracts are built against `v0.1.3` with `@cofhe/sdk v0.5.1`. Check [compatibility docs](https://cofhe-docs.fhenix.zone/get-started/introduction/compatibility) before updating. See [SMART_CONTRACTS.md](./docs/SMART_CONTRACTS.md) for a checklist of what to verify if the SDK updates.
>
> **`euint64` type breaking change (cofhe-contracts v0.1.0)**: changed `euint64` from `uint256` to `bytes32`. The deployed legacy ConfidentialUSDC on Arb Sepolia predates this change and uses `uint256` selectors. The retired `YieldDistributor` and `MuHavenStable.confidentialTransferFrom` shim handle this with a low-level call using the `uint256` selector. New MuHaven flows use `MuHavenStable` (mhUSDC) directly — `confidentialTransferFrom` is preserved as a shim for legacy paths only. See `development/DEV_WAVE_3/PUSDC_TRANSFER_ISSUE.md` for full analysis.

---

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 9+ (`npm install -g pnpm`)
- Bun (for the Vue frontend)
- Docker 24+ with `docker compose` v2 (optional — only needed to run the backend stack locally)
- Funded wallet on Arbitrum Sepolia (for testnet deploys)

### Clone + install

```bash
git clone <repo-url> muhaven
cd muhaven
pnpm install
```

The repo is a fork of `cofhe-hardhat-starter` (branch `sdk-migration`) — no separate starter clone needed.

### Environment variables

Create a root `.env` from the example:

```bash
cp .env.example .env
```

Contracts / deploy script:

```bash
PRIVATE_KEY=                  # Deployer wallet private key
ARB_SEPOLIA_RPC_URL=          # Arbitrum Sepolia RPC URL
ETHERSCAN_API_KEY=            # For contract verification
ARBISCAN_API_KEY=             # For contract verification

MUHAVEN_ENV=                  # 'prod' or 'staging' — selects deployments/arb-sepolia[-v2][.staging].json target
ISSUER_ADDRESS=               # Address to grant SUBSCRIPTION_ROLE + distribution rights (default: deployer)
```

Backend stack (separate `.env` files per service):

```bash
cp backend/.env.example     backend/.env       # API, contract addresses, JWT secret
cp fhe-worker/.env.example  fhe-worker/.env    # FHE worker wallet key
cp nav-worker/.env.example  nav-worker/.env    # NAV sources, FRED API key
```

Full env-var reference for each backend service: [BACKEND_SETUP.md](./docs/BACKEND_SETUP.md).

### Run tests

```bash
pnpm test                                         # All tests (~180, FHE mock environment)
pnpm test test/MuHavenSdk.integration.test.ts     # SDK integration (25 cases)
```

### Deploy to testnet

```bash
pnpm run deploy:v2:testnet         # production stack — writes deployments/arb-sepolia-v2.json
pnpm run deploy:v2:testnet:stage   # staging stack    — writes deployments/arb-sepolia-v2.staging.json
bash scripts/onboard-token.sh tbill1   # onboard a token (TBILL1 preset)
bash scripts/onboard-token.sh gold1    # onboard a token (GOLD1 preset)
```

The legacy Wave 3 deploy (`pnpm run deploy:testnet`) writes `deployments/arb-sepolia.json` and is preserved for reference only — superseded by `deploy:v2`. Full step-by-step guide with verification: [TESTNET_DEPLOY.md](./docs/TESTNET_DEPLOY.md).

### Run the backend stack (optional, for full E2E)

```bash
docker compose up -d --build                      # postgres + backend + fhe-worker + nav-worker + nav-publisher
# `backend/` is NOT a pnpm workspace member — run db:push from inside the dir, not via --filter:
cd backend && DATABASE_URL=postgresql://muhaven:muhaven@localhost:5432/muhaven pnpm db:push && cd -
curl -s http://localhost:3000/health              # {"status":"ok",...}
```

Homelab deploy shortcut once the stack is live on a target host:

```bash
pnpm run deploy:homelab          # prod  · master       → api.muhaven.app
pnpm run deploy:homelab:stage    # stage · agenticwave  → api-stage.muhaven.app
```

### Run the frontend

```bash
cd frontend
bun install
bun run dev:stage               # Dev server at http://localhost:7778 (reads .env.stage — staging ZeroDev)
```

For local iteration, always use `bun run dev:stage`. `bun run dev` reads `.env` whose ZeroDev project is bound to RP ID `muhaven.app`, so passkey login fails on `localhost:7778` with `"The RP ID is invalid for this domain"`. `dev:stage` reads `.env.stage` (staging ZeroDev + staging backend + staging contracts) which has `http://localhost:7778` in its allowed origins.

Live deployments:
- **Production:** [muhaven.app](https://muhaven.app) → backend [api.muhaven.app](https://api.muhaven.app)
- **Staging:** `stage.muhaven.app` → backend `api-stage.muhaven.app`

---

## Project Structure

```
muhaven/
├── README.md
├── docker-compose.yml           # postgres + backend + fhe-worker + nav-worker
├── hardhat.config.ts
│
├── docs/
│   ├── ARCHITECTURE.md          # System layers, data flow
│   ├── SMART_CONTRACTS.md       # Contract specs + EIP compliance
│   ├── SDK.md                   # MuHaven TypeScript SDK reference
│   ├── AGENT_DESIGN.md          # Agent design (chat UI shipped, loop Wave 4)
│   ├── ISSUER_MODEL.md          # Supply side
│   ├── TOKEN_LIFECYCLE.md       # Four-state lifecycle spec
│   ├── BACKEND_SETUP.md         # Docker stack + tunnel + env vars
│   ├── TESTNET_DEPLOY.md        # Contract deployment guide
│   └── COMPETITIVE_ANALYSIS.md
│
├── contracts/
│   ├── MuHavenStable.sol            # mhUSDC — confidential USDC wrapper
│   ├── MuHavenSubscription.sol      # Atomic single-tx buy/redeem coordinator
│   ├── MuHavenToken.sol             # fhERC-20 RWA token (per-token deploy)
│   ├── MuHavenTreasury.sol          # Per-token mhUSDC custody
│   ├── RedemptionQueue.sol          # Overflow redemption + epoch settlement
│   ├── YieldSnapshot.sol            # Pull-based per-epoch yield distribution
│   ├── TokenRegistry.sol            # Per-token configuration registry
│   ├── InvestorRegistry.sol         # Per-token holder enumeration
│   ├── identity/                    # ERC-3643 topology
│   │   ├── MuHavenIdentityRegistry.sol
│   │   ├── ClaimTopicsRegistry.sol
│   │   └── TrustedIssuersRegistry.sol
│   ├── compliance/                  # ModularCompliance + module library
│   │   ├── ModularCompliance.sol
│   │   └── modules/                 # CountryAllow, CountryRestrict, MaxHolders, Lockup, MaxBalance
│   ├── oracles/
│   │   ├── IssuerControlledOracle.sol
│   │   └── ChainlinkFunctionsOracle.sol
│   ├── RiskParams.sol               # Encrypted investor risk guardrails
│   ├── interfaces/                  # IMuHavenSubscription, IPriceOracle, IRedemptionQueue, IYieldSnapshot, …
│   └── mocks/                       # TestTreasury, MockPUSDC, MockPriceOracle, MockSequencerUptimeFeed, …
│
├── packages/
│   └── sdk/                         # @muhaven/sdk — TypeScript SDK with pluggable sender
│       ├── src/clients/             # MuHavenClient + Subscription/Treasury/Queue/Snapshot/Oracle clients
│       └── test/
│
├── test/                            # Hardhat / cofhe-mock tests (786 cases)
│
├── scripts/
│   ├── deploy.ts                    # Legacy Wave 3 deploy (read-only artifact)
│   ├── deploy-v2.ts                 # Production platform deploy (folds setTrustedPayer)
│   ├── onboard-token.ts             # Per-token deploy (Token + Treasury + Queue + register)
│   ├── onboard-token.sh             # Token onboarding wrapper (preset env files)
│   ├── upgrade-stable.ts            # MuHavenStable upgrade with ACL re-grant
│   ├── upgrade-yield-snapshot.ts    # YieldSnapshot upgrade with pre-flight epoch enumeration
│   ├── grant-trusted-payer.ts       # Post-upgrade re-wire / botched-deploy recovery
│   ├── unpause-token.ts             # Operator helper — setNAV + setPaused with try/finally restore
│   ├── run-yield-epoch.ts           # End-to-end epoch driver (open / batch / finalize / fund)
│   └── deploy-homelab.sh            # Dev-machine → homelab sync (prod / stage)
│
├── deployments/
│   ├── arb-sepolia-v2.json          # Authoritative production addresses
│   ├── arb-sepolia-v2.staging.json  # Staging addresses
│   ├── arb-sepolia.json             # Wave 3 (read-only artifact)
│   └── history/                     # Deployment snapshots
│
├── backend/                         # Node 20 + tsx, Clean Architecture
│   ├── api/v1/                      # REST handlers (auth, portfolio, issuer, agent stub)
│   ├── src/                         # core, domain, application, infrastructure, interface
│   ├── drizzle/                     # Drizzle schema (declarative push, not versioned migrations)
│   └── Dockerfile
│
├── fhe-worker/                      # @cofhe/sdk/node wrapper, HTTP encrypt endpoint
├── nav-worker/                      # NAV fetcher (FRED, on-chain, fallback) + source-audit-trail
├── nav-publisher/                   # On-chain NAV writer with deviation + sequencer-uptime gates
│
└── frontend/                        # Vue 3 + Vite + Bun + Tailwind v4
    ├── src/
    │   ├── providers/zerodev/       # Passkey + kernel + session keys (@zerodev/permissions)
    │   ├── services/v35/            # SubscriptionService, SnapshotService, OracleService, …
    │   ├── composables/             # useWallet, useAuth, useFhe (ephemeral-EOA permit signer)
    │   ├── stores/                  # Pinia — auth, app, agent, issuer-distribution, …
    │   └── views/
    │       ├── investor/            # PortfolioPage, TradePage, YieldsPage, ActivityPage, CashPage
    │       └── issuer/              # TokensPage, DistributePage, OnboardingWizard, InvestorsPage
    └── ...
```

---

## Links

- **Fhenix**: [fhenix.io](https://www.fhenix.io/) | [CoFHE Docs](https://cofhe-docs.fhenix.zone/)
- **CoFHE repos**: [cofhe-contracts](https://github.com/FhenixProtocol/cofhe-contracts) | [@cofhe/sdk](https://github.com/FhenixProtocol/cofhesdk) | [cofhe-hardhat-starter](https://github.com/FhenixProtocol/cofhe-hardhat-starter)
- **ReineiraOS**: [Docs](https://docs.reineira.xyz/) | [Platform Modules](https://github.com/ReineiraOS/platform-modules) | [reineira-code](https://github.com/ReineiraOS/reineira-code)
- **ERC-3643**: [erc3643.org](https://www.erc3643.org/) | [GitHub](https://github.com/ERC-3643/ERC-3643)

---

## License

MIT

---

*Built with Fhenix FHE. Privacy is not a feature — it's the architecture.*
