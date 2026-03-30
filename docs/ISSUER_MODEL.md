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

### Model 1: Wrapped tokens (hackathon)

Existing RWA tokens from external protocols are deposited into MuHaven and wrapped into fhERC-20 encrypted versions.

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

**Hackathon implementation:** For the demo, we create a mock ERC-20 "TestBUILD" token that simulates a treasury fund. The wrapping flow demonstrates the concept without needing real BUIDL tokens on testnet.

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
3. Issuer deposits into MuHaven
   │
   │  Calls depositYield() with USDC (via Privara for privacy)
   ▼
4. MuHaven creates ReineiraOS escrows
   │
   │  Platform agent creates one escrow per eligible investor
   │  Amount = proportional to their encrypted balance
   │  All amounts encrypted — issuer can't see individual positions
   ▼
5. YieldGate verifies eligibility
   │
   │  Checks: investor holds tokens? KYC valid?
   ▼
6. Yield released to investors
   │
   │  Investor's AI agent auto-claims
   │  Amount added to encrypted balance
   │  Nobody sees individual yield amounts
```

**The critical privacy property:** Even the issuer can't see how much each investor holds. They deposit a total yield amount, and MuHaven's smart contract distributes proportionally based on encrypted balances. The issuer sees total tokens outstanding (cleartext metadata) but not individual positions.

---

## Issuer experience

### Issuer onboarding flow

1. **Connect wallet** — Issuer connects their organizational wallet
2. **KYC/KYB verification** — Issuer passes business verification (via ERC-3643 claim issuer)
3. **Choose model** — Wrap existing tokens or create native tokens
4. **Configure token** — Set parameters (see below)
5. **Deploy** — MuHaven deploys contracts with issuer's configuration
6. **Distribute** — Issuer mints tokens to eligible investor addresses

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

### Issuer dashboard pages (hackathon scope)

The issuer dashboard is a separate section of the Vue 3 app, accessible via role-based routing:

**Page 1: Token management**
- View deployed tokens (name, total supply, investor count)
- Mint new tokens to whitelisted addresses
- View total outstanding (cleartext) — individual balances remain encrypted

**Page 2: Yield distribution**
- Input total yield amount for the period
- Select which token the yield applies to
- Preview distribution (shows investor count, not individual amounts)
- Confirm → creates ReineiraOS escrows for all eligible investors
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
/// @param totalYield Total USDC to distribute across all holders
/// @dev Creates ReineiraOS escrows via YieldDistributor
function depositYield(uint256 totalYield) external onlyIssuer;

/// @notice Get aggregate statistics (cleartext, not per-investor)
function totalSupplyDecrypted() external view onlyIssuer returns (uint256);
function investorCount() external view returns (uint256);
function totalYieldDistributed() external view returns (uint256);

/// @notice Update token parameters
function setYieldSchedule(uint256 intervalSeconds) external onlyIssuer;
function setMinInvestment(uint256 minUsdc) external onlyIssuer;
```

### Issuer-facing AI agent tools (future)

For production, the platform operations agent gains issuer-facing tools:

| Tool | What it does |
|------|-------------|
| `create_token` | Deploy a new fhERC-20 RWA token with configuration |
| `mint_tokens` | Mint tokens to eligible investor addresses |
| `deposit_yield` | Deposit yield and trigger distribution |
| `get_issuer_stats` | View aggregate metrics (total supply, investor count) |
| `update_whitelist` | Add/remove investors from eligibility |

---

## Hackathon implementation plan

### What to build for the demo

For the hackathon, we need to demonstrate the two-sided flow end-to-end:

**Mock issuer setup:**
1. Deploy a mock "TestTreasury" ERC-20 token (simulating an existing RWA)
2. Deploy MuHavenToken as the fhERC-20 wrapper
3. Create a test issuer wallet that can deposit yield

**Demo flow:**
1. **Issuer side:** Issuer creates a token on the dashboard → configures yield → deposits USDC as yield
2. **Platform agent:** Automatically creates ReineiraOS escrows for each eligible investor
3. **Investor side:** AI agent detects pending yield → claims it → portfolio updated (all encrypted)

### Smart contract additions needed

| Contract | Addition | Purpose |
|----------|---------|---------|
| `MuHavenToken.sol` | `mint()` (MINTER_ROLE), `depositYield()` | Role-based minting and yield deposit |
| `MuHavenToken.sol` | `onlyIssuer` modifier, `onlyMinter` modifier | Role-based access control (issuer for yield config, minter for token issuance) |
| `MuHavenToken.sol` | `investorCount()`, `totalYieldDistributed()` | Aggregate cleartext metrics for issuer |
| `MuHavenVault.sol` (new) | `wrap()`, `unwrap()` | Lock ERC-20, mint fhERC-20 (wrapper model) |
| `YieldDistributor.sol` (new) | `distributeYield()` | Read all holder balances, create proportional escrows |

---

## Revenue model (for judges)

The two-sided model creates three revenue streams:

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
│  │  YieldDistributor (proportional escrow creation)         │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                 │
│                              ▼                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Privara (payments) + ReineiraOS (escrow) + CoFHE (FHE)  │  │
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