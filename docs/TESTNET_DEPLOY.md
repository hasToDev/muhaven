# Testnet Deployment Guide

Step-by-step guide for deploying MuHaven contracts to Arbitrum Sepolia and verifying the deployment.

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

**Pre-filled variables (ReineiraOS on Arb Sepolia):**

These are already set in `.env.example` with live addresses:

```bash
USDC_ADDRESS=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
REINEIRA_ESCROW_ADDRESS=0xC4333F84F5034D8691CB95f068def2e3B6DC60Fa
PUSDC_ADDRESS=0x6b6e6479b8b3237933c3ab9d8be969862d4ed89f
```

**Optional variables:**

```bash
ISSUER_ADDRESS=                    # Defaults to deployer if empty
```

---

## Step 2: Deploy TestTreasury (Mock ERC-20)

MuHavenVault wraps an existing ERC-20 into fhERC-20. On testnet, we deploy a mock ERC-20 for this purpose.

```bash
pnpm run deploy:mocks:testnet
```

**Expected output:**

```
Deploying mock contracts to [arb-sepolia]
Deployer: 0x...

Deploying TestTreasury...
   TestTreasury: 0x...

Set in .env for testnet vault deploy:
  UNDERLYING_TOKEN_ADDRESS=0x...
```

**After running:** Copy the printed address into your `.env`:

```bash
UNDERLYING_TOKEN_ADDRESS=0x...     # The address from the output above
```

**Output file:** `deployments/arb-sepolia.mocks.json`

---

## Step 3: Deploy All Contracts

```bash
pnpm run deploy:testnet
```

This deploys 7 contracts in order and wires their dependencies:

1. **ERC3643KYCAdapter** (standalone) -- KYC whitelist
2. **InvestorRegistry** (proxy) -- investor tracking
3. **MuHavenToken** (proxy) -- fhERC-20 RWA token
4. **RiskParams** (proxy) -- encrypted risk guardrails
5. **YieldGate** (standalone) -- ReineiraOS condition resolver
6. **YieldDistributor** (proxy) -- proportional yield distribution
7. **MuHavenVault** (proxy) -- ERC-20 wrapping

**Post-deploy wiring (automatic):**

- `registry.setAuthorizedCaller(token)` -- token can register investors
- `token.grantMinter(vault)` -- vault can mint fhERC-20 when wrapping
- `distributor.setAuthorizedCaller(issuer)` -- issuer can start distributions

**Expected output:**

```
=== MuHaven Deployment Summary ===
ERC3643KYCAdapter      0x...
InvestorRegistry       0x...
MuHavenToken           0x...
RiskParams             0x...
YieldGate              0x...
YieldDistributor       0x...
MuHavenVault           0x...
```

**Output file:** `deployments/arb-sepolia.json`

> If a previous deployment exists, it is automatically archived to `deployments/history/` before overwriting.

---

## Step 4: Verify Contracts on Arbiscan

Requires `ETHERSCAN_API_KEY` in `.env`. Uses Etherscan API V2 (single key works for all chains).

### Non-proxied contracts (with constructor args)

```bash
# ERC3643KYCAdapter (arg: admin address = deployer)
npx hardhat verify --network arb-sepolia <KYC_ADDRESS> <DEPLOYER_ADDRESS>

# YieldGate (args: token address, kyc address)
npx hardhat verify --network arb-sepolia <YIELDGATE_ADDRESS> <TOKEN_PROXY_ADDRESS> <KYC_ADDRESS>

# TestTreasury (args: name, symbol, initialSupply)
npx hardhat verify --network arb-sepolia <TREASURY_ADDRESS> "Test Treasury Token" "tRWA" 10000000000000000000000000
```

### Proxied contracts (verify implementations, no constructor args)

```bash
npx hardhat verify --network arb-sepolia <INVESTOR_REGISTRY_IMPL>
npx hardhat verify --network arb-sepolia <MUHAVEN_TOKEN_IMPL>
npx hardhat verify --network arb-sepolia <RISK_PARAMS_IMPL>
npx hardhat verify --network arb-sepolia <YIELD_DISTRIBUTOR_IMPL>
npx hardhat verify --network arb-sepolia <MUHAVEN_VAULT_IMPL>
```

Implementation addresses are in `deployments/arb-sepolia.json` under each contract's `implementation` field.

---

## Step 5: Test Basic Operations

```bash
pnpm run test:testnet
```

This runs 6 tests against the deployed contracts:

1. **Contract metadata** -- reads name, symbol, decimals
2. **KYC whitelist** -- whitelists the deployer address
3. **Encrypted mint** -- mints 1000 mhRWA tokens (FHE-encrypted)
4. **Investor registry** -- verifies investor was registered
5. **Async balance decrypt** -- requests CoFHE decryption (may take >15s)
6. **Encrypted transfer** -- transfers 100 mhRWA to a random address

**Expected output:**

```
=== All Tests Passed ===
  ✓ Test 1: Contract metadata reads
  ✓ Test 2: KYC whitelist
  ✓ Test 3: Encrypted mint (1000.0 tokens)
  ✓ Test 4: Investor registry
  ✓ Test 5: Async balance decrypt
  ✓ Test 6: Encrypted transfer (100.0 tokens)
```

---

## Step 6: Test Yield Distribution

### 6a. Get testnet USDC

Go to **https://faucet.circle.com/**, select **Arbitrum Sepolia**, and send USDC to your deployer wallet. The test needs 10 USDC.

### 6b. Run the yield test

```bash
pnpm run test:yield:testnet
```

This tests the full PUSDC yield pipeline:

1. **USDC balance check** -- verifies you have enough USDC
2. **Wrap USDC to PUSDC** -- approve + wrap via ConfidentialUSDC
3. **PUSDC operator setup** -- sets YieldDistributor as operator
4. **Start distribution** -- encrypts yield amount, calls `startDistribution`
5. **Process batch** -- processes investor batch, creates escrows
6. **Distribution state** -- verifies investor count, processed count, status
7. **Yield decrypt** -- requests async decryption of yield amounts

---

## Redeployment

To redeploy (e.g., after contract changes):

1. The previous deployment is automatically archived to `deployments/history/`
2. Run steps 2-5 again
3. Update `UNDERLYING_TOKEN_ADDRESS` in `.env` if you redeploy TestTreasury
4. Update the contract addresses in `README.md`

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
| `pnpm run deploy:mocks:testnet` | Deploy TestTreasury to Arb Sepolia |
| `pnpm run deploy:testnet` | Deploy all 7 core contracts |
| `pnpm run test:testnet` | Test basic operations (whitelist, mint, transfer) |
| `pnpm run test:yield:testnet` | Test yield distribution (needs USDC) |
| `pnpm run validate:reineira` | Verify ReineiraOS contract addresses are live |
