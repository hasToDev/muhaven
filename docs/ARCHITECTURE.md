# MuHaven — Technical Architecture

> System layers, data flow, integration points, and security model.

---

## Overview

MuHaven is a **two-sided** three-layer system: an **fhERC-20 token layer** (encrypted RWA balances), a **settlement layer** (encrypted yield distribution via ReineiraOS), and an **AI agent layer** (autonomous portfolio management on encrypted state). All three layers share the Fhenix CoFHE coprocessor for fully homomorphic encryption.

The **supply side** (issuers) creates and manages RWA tokens, deposits yield, and manages investor eligibility. The **demand side** (investors) purchases tokens, receives yield, and uses AI-powered portfolio management. Both sides share the same smart contracts but interact through different interfaces.

---

## System layers

```
┌──────────────────────────────────────────────────────────────────┐
│  PRESENTATION LAYER                                              │
│                                                                  │
│  ┌─────────────────────┐     ┌──────────────────────────────┐    │
│  │  Vue 3 Dashboard    │     │  AI Agent (LLM + tools)      │    │
│  │  - Portfolio view   │     │  - Natural language intent   │    │
│  │  - Deposit/withdraw │     │  - Strategy recommendation   │    │
│  │  - Yield tracking   │     │  - Autonomous execution      │    │
│  └─────────┬───────────┘     └──────────────┬───────────────┘    │
│            │                                │                    │
│  ┌─────────┴────────────┐                   │                    │
│  │ Issuer Dashboard     │                   │                    │
│  │ - Token management   │                   │                    │
│  │ - Yield distribution │                   │                    │
│  │ - Investor mgmt      │                   │                    │
│  │ - Compliance         │                   │                    │
│  └─────────┬────────────┘                   │                    │
│            └─────────────┬──────────────────┘                    │
└──────────────────────────┼───────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────────┐
│  APPLICATION LAYER                                                      │
│                                                                         │
│  ┌──────────────┐  ┌─────────────────────┐  ┌────────────────────────┐  │
│  │ Privara SDK  │  │ MuHaven             │  │ ReineiraOS SDK         │  │
│  │              │  │ Contracts           │  │                        │  │
│  │ - deposit()  │  │                     │  │ - escrow.create()      │  │
│  │ - withdraw() │  │ - transfer()        │  │ - escrow.redeem()      │  │
│  │ - invoice()  │  │ - mint()            │  │ - insurance.purchase() │  │
│  │              │  │ - mint()            │  │                        │  │
│  │              │  │ - depositYield()    │  │                        │  │
│  │              │  │ - balanceOfSealed() │  │                        │  │
│  └──────┬───────┘  └──────┬──────────────┘  └──────────┬─────────────┘  │
│         │                 │                            │                │
│         │         ┌───────┴────────┐                   │                │
│         │         │ MuHavenVault   │                   │                │
│         │         │ - wrap()       │                   │                │
│         │         │ - unwrap()     │                   │                │
│         │         └───────┬────────┘                   │                │
│         │                 │                            │                │
│         │         ┌───────┴─────────────┐              │                │
│         │         │ YieldDistributor    │              │                │
│         │         │ - distributeYield() │              │                │
│         │         └───────┬─────────────┘              │                │
│         │                 │                            │                │
└─────────┴─────────────────┴────────────────────────────┴────────────────┘
          │                 │                            │
┌─────────▼─────────────────▼────────────────────────────▼───────────────────────────────┐
│  ENCRYPTION LAYER                                                                      │
│                                                                                        │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │  Fhenix CoFHE Coprocessor                                                        │  │
│  │                                                                                  │  │
│  │  - Encrypted types: euint8, euint16, euint32, euint64, euint128, eaddress, ebool │  │
│  │  - Operations: add, sub, mul, comparison on ciphertext                           │  │
│  │  - Threshold decryption: only authorized parties can decrypt                     │  │
│  │  - 50x faster than competing FHE implementations                                 │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                        │
│  ┌─────────────────────┐  ┌────────────────────────────────────┐                       │
│  │  Arbitrum Sepolia   │  │  Circle CCTP V2                    │                       │
│  │  (EVM execution)    │  │  (Cross-chain USDC settlement)     │                       │
│  └─────────────────────┘  └────────────────────────────────────┘                       │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

> **Image prompt**: "Create a layered architecture diagram with three horizontal tiers. Top tier labeled 'Presentation' contains three boxes: 'Issuer Dashboard' (coral fill, with sub-items: 'Token management', 'Yield distribution', 'Investor mgmt', 'Compliance'), 'Vue 3 Dashboard' (teal fill), and 'AI Agent' (teal fill). Middle tier labeled 'Application' contains five boxes: 'Privara SDK', 'MuHaven Contracts' (with sub-items: 'MuHavenToken', 'MuHavenVault', 'YieldDistributor'), 'ReineiraOS SDK'. Bottom tier labeled 'Encryption' contains one wide box: 'Fhenix CoFHE Coprocessor' with 'Arbitrum' and 'CCTP V2' below it. Arrows flow downward between tiers — both issuer and investor sides converge at the Application layer. Use a clean, minimal style with dark background and teal/coral/purple accent colors."

---

## Contract architecture

### Contract dependency graph

```
MuHavenToken (fhERC-20)
│
├── imports: @fhenixprotocol/cofhe-contracts/FHE.sol
│             (euint128, eaddress, ebool — max type is euint128)
│
├── roles: owner (deployer), issuer (RWA issuer), minters (MINTER_ROLE)
│          onlyMinter gates mint(), onlyIssuer gates depositYield()
│
├── uses: IKYCGate (interface)
│         │
│         ├── ERC3643KYCAdapter (implementation)
│         │   └── reads: ONCHAINID claims from trusted issuers
│         │
│         └── [Future] PrivaraKYCAdapter (implementation)
│             └── reads: Privara ZK compliance proofs
│
├── interacts with: ConfidentialUSDC (Privara)
│                   └── encrypted deposit/withdrawal
│
├── interacts with: YieldDistributor (new)
│                   │
│                   ├── called by: MuHavenToken.depositYield()
│                   ├── reads: all holder encrypted balances
│                   └── creates: proportional ReineiraOS escrows
│
└── interacts with: YieldGate (ReineiraOS plugin)
                    │
                    ├── implements: IConditionResolver
                    │   └── isConditionMet(escrowId) → bool
                    │
                    └── reads: MuHavenToken.encryptedBalanceOf()
                              to verify yield eligibility

MuHavenVault (new — wrapping model)
│
├── locks: external ERC-20 RWA tokens (e.g., BUIDL, OUSG)
├── mints: equivalent fhERC-20 via MuHavenToken.mint() (vault has MINTER_ROLE)
└── unwraps: burn fhERC-20, release original ERC-20
```

### Core contract: MuHavenToken.sol

```solidity
// Simplified structure — see SMART_CONTRACTS.md for full spec
contract MuHavenToken {
    // Encrypted state
    mapping(address => euint128) private _encryptedBalances;
    mapping(address => mapping(address => euint128)) private _encryptedAllowances;
    euint128 private _encryptedTotalSupply;

    // KYC gate (swappable)
    IKYCGate public kycGate;
    address public owner;
    address public issuer;

    // Issuer role-based access
    modifier onlyIssuer() {
        require(msg.sender == issuer, "Only issuer");
        _;
    }

    // Risk parameters (encrypted per investor)
    mapping(address => euint64) private _maxDrawdown;
    mapping(address => euint64) private _minYieldThreshold;

    // Transfer hook — checks KYC before every transfer
    function _beforeTokenTransfer(address from, address to, euint128 amount) internal {
        require(kycGate.isEligible(to), "KYC: recipient not eligible");
    }

    // Minting — any address with MINTER_ROLE (issuer + vault) can mint
    function mint(address to, InEuint128 calldata encryptedAmount) external onlyMinter;

    // Yield deposit — issuer deposits total yield, YieldDistributor creates escrows
    function depositYield(uint256 totalYield) external onlyIssuer;

    // Sealed output — only the permit holder can unseal client-side
    // NOTE: FHE.decrypt() is async in CoFHE — use sealed outputs instead
    function balanceOfSealed(
        PermissionedV2 memory permission
    ) public view withPermission(permission) returns (SealedUint memory) {
        return FHE.sealoutputTyped(_encryptedBalances[permission.issuer], permission.sealingKey);
    }
}
```

---

## Data flow

### Flow 1: Investor deposits and buys RWA tokens

<img src="./images/flow-deposit.svg" alt="Deposit Flow" width="850" />

### Flow 2: Yield distribution via ReineiraOS escrow

<img src="./images/flow-yield.svg" alt="Yield Distribution Flow" width="850" />

### Flow 3: AI agent advisory and execution

<img src="./images/flow-agent.svg" alt="Agent Advisory Flow" width="850" />

### Flow 4: Issuer creates token and distributes yield

<img src="./images/flow-issuer.svg" alt="Issuer Flow" width="850" />

**Issuer yield deposit flow (step by step):**

1. Issuer opens the Issuer Dashboard → selects a token → enters total yield amount (e.g., $50,000)
2. Issuer calls `MuHavenToken.depositYield(50000)` via dashboard
3. USDC is transferred from issuer to MuHavenToken contract
4. MuHavenToken calls `YieldDistributor.distributeYield()` with the total amount
5. YieldDistributor reads each investor's encrypted balance from MuHavenToken
6. For each investor, it calculates proportional yield using FHE math (encrypted)
7. YieldDistributor creates a ReineiraOS escrow per investor, gated by YieldGate
8. YieldGate verifies eligibility (holds tokens? KYC valid?) before releasing each escrow
9. Investor's AI agent auto-claims yield → amount added to encrypted balance

**Key insight:** Issuers and investors share the same smart contracts but interact through different interfaces. The fhERC-20 token, KYC gate, and yield gate serve both sides. The issuer dashboard and investor AI agent are just different UX layers on top of the same protocol.

---

## Integration points

### MuHaven ↔ Fhenix CoFHE

- **What**: All encrypted types (`euint8` through `euint128`, `eaddress`, `ebool`) and FHE operations.
- **How**: Import `@fhenixprotocol/cofhe-contracts/FHE.sol` in Solidity. SDK uses `cofhejs` for client-side encryption.
- **Where**: Every contract that handles amounts, balances, or sensitive state.

### MuHaven ↔ Privara

- **What**: Encrypted stablecoin deposit and withdrawal.
- **How**: Privara SDK (`@privara/sdk`) for payment link creation and settlement.
- **Where**: Investor onboarding (deposit) and exit (withdrawal) flows.
- **Limitation**: Compliance features (OFAC, KYT) not yet in codebase — using IKYCGate adapter instead.

### MuHaven ↔ ReineiraOS

- **What**: Encrypted escrow for yield distribution + insurance pools.
- **How**: ReineiraOS SDK (`@reineira-os/sdk`) for escrow creation. Custom `IConditionResolver` (YieldGate) for release logic.
- **Where**: Yield distribution pipeline, insurance purchasing.
- **Key integration**: YieldGate reads MuHavenToken's encrypted balances to verify eligibility.

### MuHaven ↔ ERC-3643

- **What**: KYC/AML compliance via ONCHAINID and verifiable claims.
- **How**: ERC3643KYCAdapter implements IKYCGate, checks ONCHAINID claims from trusted issuers.
- **Where**: Token transfer hook (`_beforeTokenTransfer`).
- **Swap path**: IKYCGate interface allows hot-swapping to zkMe, Privara, or any future provider.

---

## Security model

### Trust assumptions

| Component | Trust level | Mitigation |
|-----------|------------|------------|
| Fhenix CoFHE | External dependency — FHE key compromise would expose all encrypted state | Threshold decryption distributes key across multiple parties |
| Privara | Non-custodial — never holds funds | Investor wallet signs all transactions |
| ReineiraOS | Non-custodial escrow — funds in smart contract | Gate plugin controls release; escrow isolation prevents cross-contamination |
| AI Agent | Agent wallet — funded with capped balance, revocable | Investor controls the cap; can drain wallet anytime; session keys in production |
| ERC-3643 Claims | Trusted issuers vouch for KYC status | Multiple issuers can be required; issuer registry is on-chain |

### Agent security model

```
Investor Wallet (full control)
│
├── Funds a dedicated agent wallet with:
│   ├── Max USDC balance: $X (investor chooses the cap)
│   ├── Whitelisted contracts: [MuHavenToken, Privara, ReineiraOS]
│   └── Revocable: investor can drain the agent wallet anytime
│
└── Agent wallet used by AI Agent
    ├── Can: execute trades within funded balance
    ├── Can: claim yields
    ├── Can: rebalance within drift tolerance
    ├── Cannot: spend more than what's in the agent wallet
    ├── Cannot: interact with non-whitelisted contracts
    ├── Cannot: transfer to external addresses
    └── Cannot: unseal other users' data
```

**Production upgrade (post-hackathon):** Replace the agent wallet with EIP-7702 session keys — scoped, time-limited, revocable wallet permissions that don't require a separate funded wallet.

---

## Deployment

### Testnet (hackathon)

- **Chain**: Arbitrum Sepolia
- **CoFHE**: Fhenix testnet coprocessor
- **ReineiraOS**: Deployed on Arbitrum Sepolia (live)
- **Privara**: Testnet demo available at app.privara.dev

### Production (post-hackathon)

- **Chain**: Arbitrum One
- **CoFHE**: Fhenix production coprocessor
- **Audit**: Required before mainnet deployment
- **Timelock**: Admin upgrades with delay + multisig

---

> **Image prompt for architecture overview**: "Create a clean system architecture diagram showing a two-sided platform. LEFT: 'Issuer Dashboard' (coral accent) with sub-items: 'Create token', 'Deposit yield', 'Manage investors', 'Compliance'. RIGHT: 'AI Agent' (teal accent) with sub-items: 'Advisory', 'Portfolio mgmt', 'Yield claiming'. CENTER: Three connected platforms — MuHaven contracts (center, containing MuHavenToken, MuHavenVault, YieldDistributor), Privara (left, teal accent), and ReineiraOS (right, purple accent) — all sitting on top of a shared foundation labeled 'Fhenix CoFHE' (gray). Arrows show data flow from both issuer and investor sides down to shared contracts. Use a dark background with minimal style, no gradients. Include the Arbitrum logo on the foundation layer."
