# MuHaven — Issuer Model & Supply Side

> How RWA tokens enter MuHaven, how yield flows from issuers to investors, and the issuer experience.

---

## The missing piece

MuHaven is a **two-sided platform**:

| Side | User | What they do | What they get |
|------|------|-------------|--------------|
| **Demand** | Investors | Buy encrypted RWA tokens, receive yield, AI-managed portfolio | Privacy, AI advisory, MEV protection |
| **Supply** | Issuers | Create/list RWA tokens, deposit yield, manage distribution | Confidential distribution, compliance, access to privacy-seeking investors |

This document covers the **supply side** — everything the investor-facing docs don't.

---

## How RWA tokens enter MuHaven

MuHaven supports two token models. Both produce the same fhERC-20 encrypted tokens for investors.

### Model 1: Wrapped tokens (live)

Existing RWA tokens from external protocols are deposited into MuHaven and wrapped into fhERC-20 encrypted versions. This is the model behind the 11 active tokens currently onboarded on Arbitrum Sepolia (TBILL1/GOLD1 retired): CETES, USYC, BUIDL, EUTBL, syrupUSDC, USDY, ONyc, MUon, NVDAon, STRCx, TSLAx.

```
External RWA token              MuHaven
(BUIDL, OUSG, etc.)
       │
       │  Investor deposits
       │  standard ERC-20
       ▼
┌───────────────┐         ┌──────────────────┐
│ Lock in vault │────────>│ Mint fhERC-20    │
│ (custodied)   │         │ (encrypted       │
│               │         │  balance)        │
└───────────────┘         └──────────────────┘
       │
       │  1:1 backing
       │  Investor can unwrap anytime
```

**How it works:**
1. Investor holds standard ERC-20 RWA tokens (e.g., BUIDL on Ethereum)
2. Deposits into MuHaven's vault contract
3. MuHaven locks the ERC-20 and mints equivalent fhERC-20 tokens with encrypted balance
4. Investor now holds private version of the same asset
5. To exit: burn fhERC-20, vault releases original ERC-20

**Who decides the yield:** The underlying protocol (e.g., BlackRock for BUIDL). MuHaven harvests the yield accrual and distributes it privately.

**Testnet implementation:** On Arbitrum Sepolia, each token is backed by a mock ERC-20 (e.g., a "TestTreasury" token simulating a treasury fund). The wrapping flow demonstrates the concept without needing the real underlying tokens on testnet.

### Model 2: Native issuance (production)

RWA issuers create tokens directly on MuHaven. The tokens are born encrypted — no wrapping needed.

```
RWA Issuer                    MuHaven
(fund manager, property
 company, bond issuer)
       │
       │  Creates token via
       │  issuer dashboard
       ▼
┌───────────────────────┐
│ Configure token:      │
│ - Name, symbol        │
│ - Asset class         │
│ - Yield rate/schedule │
│ - KYC tier required   │
│ - Max investors       │
│ - Jurisdiction rules  │
└──────────┬────────────┘
           │
           ▼
┌──────────────────────┐
│ Deploy fhERC-20      │
│ + IKYCGate config    │
│ + YieldGate config   │
│ (all encrypted       │
│  from birth)         │
└──────────────────────┘
```

**How it works:**
1. Issuer onboards via MuHaven's issuer dashboard
2. Configures token parameters (asset class, yield schedule, compliance rules)
3. MuHaven deploys an fhERC-20 contract with the issuer's KYC gate and yield gate pre-configured
4. Issuer mints tokens and distributes to eligible investors
5. Yield is deposited by the issuer on a schedule they define

**Who decides the yield:** The issuer. They set the yield rate based on the real-world asset's performance (bond coupon rate, rental income, fund NAV growth).

---

## Who decides the yield?

This is the most common question. The answer: **MuHaven never decides yield. It only distributes it privately.**

| Token type | Who sets the yield | How yield enters MuHaven | Example |
|-----------|-------------------|-------------------------|---------|
| Wrapped treasury token | Underlying protocol (BlackRock, Ondo) | NAV increases, MuHaven harvests difference | BUIDL: ~4.8% APY set by BlackRock |
| Wrapped money market | Underlying protocol | Interest accrues, MuHaven harvests | OUSG: ~5.2% APY set by Ondo |
| Native bond token | Issuer sets coupon rate at issuance | Issuer deposits USDC on coupon dates | Corporate bond: 6% annual, paid quarterly |
| Native real estate token | Issuer reports rental income | Issuer deposits rental proceeds monthly | Property fund: variable yield from rents |
| Native private credit | Issuer sets interest rate | Borrower repayments flow through escrow | Private loan: 8% APY, monthly distribution |

### Yield flow: step by step

```
1. Yield source (real-world asset performance)
   │
   │  Bond coupon / rental income / fund NAV increase
   ▼
2. Issuer determines amount
   │
   │  "This month's yield: $50,000 across all holders"
   ▼
3. Issuer opens a yield epoch
   │
   │  Funds a per-epoch YieldSnapshot in mhUSDC (MuHaven's confidential
   │  USDC wrapper). Flow: openEpoch → snapshotBatch → finalizeSnapshot → fundEpoch
   ▼
4. MuHaven records a cleartext ratePerShare for the epoch
   │
   │  Per-epoch fixed-point ratePerShare (cleartext); per-investor shares
   │  stay encrypted. The issuer sees aggregates only — never individual positions.
   ▼
5. Eligibility gate
   │
   │  Checks: investor holds tokens? KYC valid?
   ▼
6. Yield claimed by investors (pull-based)
   │
   │  Investor (or their AI agent) calls claimYield against the epoch
   │  Amount added to encrypted balance
   │  Nobody sees individual yield amounts
```

**The critical privacy property:** Even the issuer can't see how much each investor holds. They deposit a total yield amount, and MuHaven's smart contract distributes proportionally based on encrypted balances. The issuer sees total tokens outstanding (cleartext metadata) but not individual positions.

---

## Issuer experience

### Issuer onboarding flow

1. **Connect wallet** — Issuer connects their organizational wallet (issuer role is chosen at account creation and fixed per passkey)
2. **KYC/KYB verification** — Issuer passes business verification (via ERC-3643 claim issuer)
3. **Choose model** — Wrap existing tokens or create native tokens
4. **Configure token** — Set parameters (see below) via the self-serve onboarding wizard (live)
5. **Deploy** — MuHaven deploys contracts with issuer's configuration
6. **Distribute** — Issuer mints tokens to eligible investor addresses

The self-serve onboarding wizard is live; 11 RWA tokens have been onboarded through this pipeline on Arbitrum Sepolia.

### Token configuration parameters

| Parameter | Description | Example |
|-----------|------------|---------|
| Token name & symbol | Display name for the token | "MuHaven Treasury Bond Fund" / MHTB |
| Asset class | Category of the underlying asset | Treasury, bond, real estate, private credit |
| Yield type | How yield is calculated | Fixed rate, variable, NAV-based |
| Yield schedule | How often yield is distributed | Monthly, quarterly, on-demand |
| Expected yield | Indicative APY (informational, not guaranteed) | 4.8% APY |
| KYC tier required | Minimum investor qualification | Tier 1 (retail) or Tier 2 (accredited) |
| Jurisdiction restrictions | Which countries are allowed/blocked | US-only, EU-only, global ex-sanctions |
| Max investors | Cap on total token holders | 500 (Reg D), unlimited (Reg S) |
| Min investment | Minimum purchase amount | $1,000 USDC |
| Lock-up period | Minimum holding period | 90 days, 1 year, none |

### Issuer dashboard pages

The issuer dashboard is a separate section of the Vue 3 app, accessible via role-based routing:

**Page 1: Token management**
- View deployed tokens (name, total supply, investor count)
- Mint new tokens to whitelisted addresses
- View total outstanding (cleartext) — individual balances remain encrypted

**Page 2: Yield distribution**
- Input total yield amount for the period
- Select which token the yield applies to
- Preview distribution (shows investor count, not individual amounts)
- Confirm → opens and funds a per-epoch YieldSnapshot for all eligible investors
- Track distribution status (pending, claimed, expired)

**Page 3: Investor management**
- View whitelisted investors (addresses + KYC status)
- Add/remove investors from whitelist
- View aggregate metrics (total investors, total minted, total yield distributed)
- Cannot see individual balances — only aggregate totals

**Page 4: Compliance**
- View KYC gate configuration
- Update trusted claim issuers
- View jurisdiction distribution (aggregate, not per-investor)

### Issuer-facing smart contract functions

```solidity
// Functions the issuer calls (added to MuHavenToken.sol)

/// @notice Mint tokens to an eligible investor (requires MINTER_ROLE)
/// @dev Both issuer and MuHavenVault hold MINTER_ROLE
function mint(address to, InEuint128 calldata amount) external onlyMinter;

/// @notice Deposit yield for distribution (issuer only)
/// @param totalYield Total mhUSDC to distribute across all holders
/// @dev Funds a per-epoch YieldSnapshot for proportional pull-based claims
function depositYield(uint256 totalYield) external onlyIssuer;

/// @notice Get aggregate statistics (cleartext, not per-investor)
function totalSupplyDecrypted() external view onlyIssuer returns (uint256);
function investorCount() external view returns (uint256);
function totalYieldDistributed() external view returns (uint256);

/// @notice Update token parameters
function setYieldSchedule(uint256 intervalSeconds) external onlyIssuer;
function setMinInvestment(uint256 minUsdc) external onlyIssuer;
```

### Issuer-facing AI agent tools

The platform agent (HavenBot / MCP) exposes issuer-facing tools. Some are live today (e.g.
unpausing a token via `muhaven.issuer.unpause_token`, which does `setNAV` + `setPaused(false)`,
plus yield distribution, KYC add/remove, and audit queries); others are planned:

| Tool | What it does | Status |
|------|-------------|--------|
| `unpause_token` | Set NAV + unpause an existing token | Live |
| `distribute_yield` | Open + fund a yield epoch | Live |
| `kyc_add` / `kyc_remove` | Add/remove investors from the whitelist | Live |
| `audit_query` | View aggregate metrics (total supply, investor count) | Live |
| `create_token` | Deploy a new fhERC-20 RWA token with configuration | Planned (self-serve wizard is the live path) |

---

## Implementation status

### The two-sided flow end-to-end (shipped)

The full two-sided flow runs live on Arbitrum Sepolia:

**Issuer setup:**
1. Each token is backed by a mock ERC-20 (e.g., "TestTreasury") simulating an existing RWA
2. MuHavenToken acts as the fhERC-20 wrapper
3. The issuer wallet opens and funds yield epochs

**Flow:**
1. **Issuer side:** Issuer onboards a token via the self-serve wizard → configures yield → funds a yield epoch in mhUSDC
2. **Platform:** A per-epoch YieldSnapshot records a cleartext ratePerShare; per-investor shares stay encrypted
3. **Investor side:** Investor (or AI agent) detects claimable yield → claims it (pull-based) → portfolio updated (all encrypted)

### Smart contract surface

| Contract | Surface | Purpose |
|----------|---------|---------|
| `MuHavenToken.sol` | `mint()` (MINTER_ROLE), `depositYield()` | Role-based minting and yield deposit |
| `MuHavenToken.sol` | `onlyIssuer` modifier, `onlyMinter` modifier | Role-based access control (issuer for yield config, minter for token issuance) |
| `MuHavenToken.sol` | `investorCount()`, `totalYieldDistributed()` | Aggregate cleartext metrics for issuer |
| `MuHavenVault.sol` | `wrap()`, `unwrap()` | Lock ERC-20, mint fhERC-20 (wrapper model) |
| `YieldDistributor` / `YieldSnapshot` | `distributeYield()` / per-epoch snapshot | Proportional pull-based yield distribution |

---

## Revenue model (planned)

The two-sided model is designed to support three revenue streams. These fees are not yet active —
they are on the roadmap:

| Revenue stream | Rate | Who pays | When |
|---------------|------|----------|------|
| Wrapping fee | 0.1% of wrapped amount | Investor | On wrap/unwrap |
| Issuance fee | 0.2% of total supply | Issuer | On native token deployment |
| Yield distribution fee | 0.1% of distributed yield | Issuer | On each distribution |

All fees are encrypted — competitors can't reverse-engineer MuHaven's revenue from on-chain data.

---

## How this fits the existing architecture

```
┌────────────────────────────────────────────────────────────────┐
│  ISSUER SIDE (new)                    INVESTOR SIDE (existing) │
│                                                                │
│  ┌───────────────────┐                 ┌────────────────────┐  │
│  │ Issuer Dashboard  │                 │ AI Agent + Chat    │  │
│  │ - Create token    │                 │ - Advisory         │  │
│  │ - Deposit yield   │                 │ - Portfolio mgmt   │  │
│  │ - Manage investors│                 │ - Yield claiming   │  │
│  └────────┬──────────┘                 └─────────┬──────────┘  │
│           │                                      │             │
│           ▼                                      ▼             │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   MuHaven Contracts                      │  │
│  │                                                          │  │
│  │  MuHavenToken (fhERC-20)  ←──── shared ────→  IKYCGate   │  │
│  │  MuHavenVault (wrap/unwrap)                    YieldGate │  │
│  │  YieldDistributor (proportional per-epoch yield snapshot) │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                 │
│                              ▼                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  MuHavenStable (mhUSDC) + YieldSnapshot + CoFHE (FHE)    │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

The key insight: issuers and investors share the same smart contracts but interact through different interfaces. The fhERC-20 token, KYC gate, and yield gate serve both sides. The issuer dashboard and investor AI agent are just different UX layers on top of the same protocol.

---

## Comparison: MuHaven vs. existing RWA platforms

| Feature | Securitize | Ondo | Maple | **MuHaven** |
|---------|-----------|------|-------|-------------|
| Token issuance | Yes | Yes | Yes | **Yes (native + wrapped)** |
| Balance privacy | No | No | No | **FHE-encrypted** |
| Yield distribution | Manual/centralized | Automatic (NAV) | Automatic | **Encrypted via escrow** |
| Issuer sees individual positions | Yes | Yes | Yes | **No — only aggregates** |
| Investor sees own position | Yes (public) | Yes (public) | Yes (public) | **Yes (sealed output, private)** |
| AI portfolio management | No | No | No | **Yes** |
| Compliance | Centralized KYC | Centralized KYC | Centralized KYC | **Modular (ERC-3643 + ZK)** |

The differentiator: on existing platforms, the issuer can see every investor's exact position. On MuHaven, the issuer can see aggregate metrics (total supply, investor count) but not individual balances. This is confidential distribution — the privacy property institutions actually want.

<img src="./docs/images/issuer-model.jpg" alt="Issuer Model" width="850" />

---