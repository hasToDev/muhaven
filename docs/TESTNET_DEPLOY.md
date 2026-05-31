# Testnet Deployment Guide

Step-by-step guide for deploying the MuHaven platform contracts to Arbitrum Sepolia, onboarding RWA tokens, and verifying the deployment.

> **Deploy targets:** `MUHAVEN_ENV=prod` writes `deployments/arb-sepolia-v2.json` and `MUHAVEN_ENV=staging` writes `deployments/arb-sepolia-v2.staging.json` — those are the authoritative address files. The legacy `pnpm run deploy:testnet` (single-token core) writes the read-only `deployments/arb-sepolia.json` artifact and is not part of the current platform flow.

---

## Prerequisites

### 1. Wallet

- An Ethereum wallet with a private key (hex format, with `0x` prefix)
- Funded with testnet ETH on Arbitrum Sepolia (~0.1 ETH for deployment gas)
- Faucet: [GetBlock](https://getblock.io/faucet/arb-sepolia/)

### 2. API Keys

| Key | Required | Where to get |
|-----|----------|-------------|
| `ARB_SEPOLIA_RPC_URL` | Yes | [OnFinality](https://onfinality.io/) or use public RPC `https://sepolia-rollup.arbitrum.io/rpc` |
| `ETHERSCAN_API_KEY` | For verification | [Etherscan](https://etherscan.io/apis) (works for Arbiscan via API V2) |

### 3. No Fhenix API key needed

CoFHE is accessed through on-chain smart contract interactions, not via API keys. Authentication uses standard EIP-712 permits (wallet signatures).

### 4. Dependencies installed

```bash
pnpm install
pnpm compile
```

---

## Step 1: Configure Environment

Copy the example and fill in your values:

```bash
cp .env.example .env
```

**Required variables:**

```bash
PRIVATE_KEY=0x...                  # Deployer wallet private key
ARB_SEPOLIA_RPC_URL=https://...    # Arbitrum Sepolia RPC URL
ETHERSCAN_API_KEY=...              # For contract verification (optional)
```

**Pre-filled variables (live on Arb Sepolia):**

These are already set in `.env.example` with live addresses:

```bash
USDC_ADDRESS=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d   # Circle USDC on Arb Sepolia
```

**Optional variables:**

```bash
ISSUER_ADDRESS=                    # Defaults to deployer if empty
```

---

## Step 2: Deploy the Platform Contracts

The platform deploy stands up the shared singletons: the confidential USDC wrapper
(`MuHavenStable`, ticker **mhUSDC**), the ERC-3643 compliance stack, the token registry, the
subscription engine, the yield-snapshot state machine, and the NAV oracle.

```bash
pnpm run deploy:v2:testnet         # prod  → deployments/arb-sepolia-v2.json
pnpm run deploy:v2:testnet:stage   # stage → deployments/arb-sepolia-v2.staging.json
```

This deploys and wires (among others):

1. **MuHavenStable** (proxy) -- confidential USDC wrapper (mhUSDC)
2. **ERC-3643 stack** -- `ClaimTopicsRegistry`, `TrustedIssuersRegistry`, `MuHavenIdentityRegistry`, `ModularCompliance` (KYC whitelist for testnet)
3. **TokenRegistry** (proxy) -- per-token config (issuer, oracle, paused state)
4. **InvestorRegistry** (proxy) -- holder enumeration
5. **MuHavenSubscription** (proxy) -- buy/sell primary-market engine
6. **YieldSnapshot** (proxy) -- two-phase yield snapshot + claim
7. **IssuerControlledOracle** (proxy) -- on-chain NAV oracle (written by `nav-publisher`)
8. **ChainlinkFunctionsOracle** -- off-chain NAV source adapter

**Output file:** `deployments/arb-sepolia-v2[.staging].json`.

> If a previous deployment exists, it is automatically archived to `deployments/history/` before overwriting.

---

## Step 3: Onboard RWA Tokens

Each tradable RWA token gets its own per-token stack — `MuHavenToken` (fhERC-20), `MuHavenTreasury`
(ERC-20 ↔ fhERC-20 wrapper), and `RedemptionQueue` — registered against the platform singletons.
Onboard one token at a time with the wrapper script, which sources the matching preset from
`scripts/env/<symbol>.env`:

```bash
bash scripts/onboard-token.sh <symbol> [prod|stage]

# Examples:
bash scripts/onboard-token.sh cetes          # prod  (default env)
bash scripts/onboard-token.sh usyc  stage    # staging
```

Presets exist in `scripts/env/` for the currently onboarded set. **11 tokens are active in prod**
(`USYC`, `BUIDL`, `CETES`, `EUTBL`, `syrupUSDC`, `USDY`, `ONyc`, `MUon`, `NVDAon`, `STRCx`, `TSLAx`).
`TBILL1` and `GOLD1` were the original two tokens and are retired (their `scripts/env/` presets and
deploy-file entries remain for history).

Each successful onboard appends a `tokens.<SYMBOL>` block to the matching deploy file. After
onboarding, propagate the addresses to the service env files:

- `backend/.env`: per-token JSON arrays/maps — `MUHAVEN_TOKEN_ADDRESSES_JSON`, `YIELD_SNAPSHOT_*`, `REDEMPTION_QUEUE_*`, `TREASURY_*`.
- `frontend/.env`: per-token JSON maps — `VITE_TREASURIES_JSON`, `VITE_QUEUES_JSON`, `VITE_YIELD_SNAPSHOTS_JSON` (map keys MUST be lowercase, per `frontend/src/contracts/addresses.ts`).

---

## Step 4: Verify Contracts on Arbiscan

Requires `ETHERSCAN_API_KEY` in `.env`. Uses Etherscan API V2 (single key works for all chains).

### Proxied contracts (verify implementations, no constructor args)

Pull the `implementation` address for each proxy from the deploy file and verify it:

```bash
npx hardhat verify --network arb-sepolia <MUHAVEN_STABLE_IMPL>
npx hardhat verify --network arb-sepolia <TOKEN_REGISTRY_IMPL>
npx hardhat verify --network arb-sepolia <MUHAVEN_SUBSCRIPTION_IMPL>
npx hardhat verify --network arb-sepolia <YIELD_SNAPSHOT_IMPL>
npx hardhat verify --network arb-sepolia <ISSUER_CONTROLLED_ORACLE_IMPL>
npx hardhat verify --network arb-sepolia <INVESTOR_REGISTRY_IMPL>
# Per token:
npx hardhat verify --network arb-sepolia <MUHAVEN_TOKEN_IMPL>
npx hardhat verify --network arb-sepolia <MUHAVEN_TREASURY_IMPL>
npx hardhat verify --network arb-sepolia <REDEMPTION_QUEUE_IMPL>
```

Implementation addresses are in `deployments/arb-sepolia-v2.json` under each contract's
`implementation` field (`contracts.<NAME>.implementation` for singletons,
`tokens.<SYMBOL>.contracts.<NAME>.implementation` for per-token stacks).

### Standalone contracts (with constructor args)

ERC-3643 components and the KYC adapter take constructor args — read them from the deploy file and
pass them positionally, e.g.:

```bash
npx hardhat verify --network arb-sepolia <KYC_ADAPTER_ADDRESS> <ADMIN_ADDRESS>
```

---

## Step 5: Test Basic Operations

```bash
pnpm run test:testnet
```

This runs a set of read/write checks against the deployed contracts (contract metadata, KYC
whitelist, encrypted mint, investor registry, async balance decrypt, encrypted transfer). The async
balance decrypt may take >15s on the live CoFHE coprocessor — see Troubleshooting.

---

## Step 6: Test Yield Distribution

### 6a. Get testnet USDC

Go to **https://faucet.circle.com/**, select **Arbitrum Sepolia**, and send USDC to your deployer wallet. The test needs ~10 USDC.

### 6b. Run the yield test

```bash
pnpm run test:yield:testnet
```

This exercises the mhUSDC yield pipeline end-to-end: wrap USDC → mhUSDC, snapshot holders, fund an
epoch on `YieldSnapshot`, and claim. Per-share yield rate is supplied as a cleartext rate
(`ratePerShare`) — see `docs/COFHE_TN_INDEXER_CHAIN_LENGTH_REPORT.md` for the architectural reason.

---

## Redeployment

To redeploy (e.g., after platform contract changes):

1. The previous deployment is automatically archived to `deployments/history/`.
2. Re-run `pnpm run deploy:v2:testnet[:stage]` for platform singletons, or `bash scripts/onboard-token.sh <symbol> [env]` for a single token's stack.
3. Most contracts are UUPS proxies — for an implementation-only change, prefer an upgrade script over a full redeploy (see `scripts/` for the per-contract `deploy-*-impl` / `manual-upgrade-*` helpers).

---

## Troubleshooting

### `ISSUER_ADDRESS` empty string error

If you see `invalid address (argument="_issuer", value="")`, your `.env` has `ISSUER_ADDRESS=` (set but empty). Either remove the line entirely or set it to your deployer address. The deploy script defaults to the deployer when the variable is empty.

### `isEligible` returns false after whitelisting

RPC load-balancers may serve slightly stale state. The test script retries up to 5 times with 3s delay. If it still fails, wait a few seconds and re-run.

### Async decrypt shows "not yet complete"

The CoFHE coprocessor on live testnet takes longer than 15 seconds. This is expected — the decrypt result will be available if you query it again later.

### Etherscan verification fails with "deprecated V1 endpoint"

Make sure `hardhat.config.ts` uses the `customChains` config with `https://api.etherscan.io/v2/api?chainid=421614`. This is already configured in the repo.

---

## Quick Reference

| Command | What it does |
|---------|-------------|
| `pnpm run deploy:v2:testnet` | Deploy platform singletons (prod → `arb-sepolia-v2.json`) |
| `pnpm run deploy:v2:testnet:stage` | Deploy platform singletons (stage → `arb-sepolia-v2.staging.json`) |
| `bash scripts/onboard-token.sh <symbol> [prod\|stage]` | Onboard one RWA token's per-token stack |
| `pnpm run deploy:testnet` | Legacy single-token core deploy → read-only `arb-sepolia.json` artifact |
| `pnpm run test:testnet` | Test basic operations (whitelist, mint, transfer) |
| `pnpm run test:yield:testnet` | Test yield distribution (needs USDC) |
| `pnpm run validate:reineira` | Verify legacy/external contract addresses are live |
