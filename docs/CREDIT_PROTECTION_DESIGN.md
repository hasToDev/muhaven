# Credit Default Protection, Encrypted Governance & Cross-Chain KYC Design

This document specifies three new feature modules for MuHaven, designed to be fully compatible with the existing contract architecture, FHE patterns, and storage layouts.

| Feature | Priority | Scope | Status |
|---|---|---|---|
| Credit Default Protection | P0 | Full contracts + tests | Implement |
| Encrypted Governance | P0 | Full contracts + tests | Implement |
| Cross-Chain KYC Attestation | P1 | Design + contract stubs | Stub |

---

## 1. Overview

### Problem Statement

On-chain insurance for RWA defaults is critically underdeveloped. Fitch data shows a **9.2% default rate** among private credit borrowers, while ~$700M in leveraged RWA positions sit across DeFi protocols with **no hedging instrument**. When issuers default, investors have no on-chain recourse — no protection pool, no automatic payout, no encrypted governance mechanism to force action.

MuHaven's FHE infrastructure and ReineiraOS escrow integration uniquely position it to offer **privacy-preserving default protection** — coverage amounts, payouts, and governance votes are all encrypted, consistent with the platform's core privacy guarantee.

### Design Principles

1. **Zero investor friction** — Protection is structural (issuer-funded first-loss reserve), not a product investors buy
2. **Privacy-preserving** — Reserve balances encrypted, payout amounts encrypted, governance votes encrypted
3. **Compatible** — Same Solidity version, upgrade patterns, FHE patterns, ReineiraOS integration
4. **Modular** — Each contract is independently deployable and testable
5. **Reuses existing infrastructure** — InvestorRegistry for investor enumeration, ReineiraOS escrow for payouts, YieldGate for claim conditions, PUSDC for settlement

### Feature Summary

**Credit Default Protection:** Issuers deposit a mandatory PUSDC first-loss reserve when listing tokens. The reserve rate (percentage) is public as a trust signal; the reserve balance is FHE-encrypted. If the issuer defaults, the reserve automatically distributes to all investors via ReineiraOS escrows — same batched pattern as YieldDistributor.

**Encrypted Governance:** FHE-encrypted ballot voting for force-triggering protection when issuers are uncooperative (won't call `windDown`). Vote weight equals the voter's encrypted token balance — `FHE.select` and `FHE.add` accumulate weighted votes without revealing individual choices. Threshold comparison uses FHE operations so the result is only revealed via async decrypt.

**Cross-Chain KYC Attestation:** EIP-712 signed attestations from MuHaven's KYC authority that can be verified on any EVM chain. The destination-chain verifier implements `IKYCGate`, so any protocol can use MuHaven KYC as a drop-in gate.

---

## 2. System Architecture

### Contract Dependency Diagram

```
┌───────────────────────────────────────────────────────────────────────┐
│  EXISTING CONTRACTS                                                   │
│                                                                       │
│  MuHavenToken ◄──── IKYCGate (ERC3643KYCAdapter)                     │
│       │                    │                                          │
│       ├──── InvestorRegistry ◄────────────────────┐                   │
│       │         │                                  │                  │
│  MuHavenVault   YieldDistributor ──── YieldGate ──── ReineiraOS      │
│                      │                    ▲                           │
│                      │                    │ (reused for payouts)      │
│  ─── NEW CONTRACTS ──┼────────────────────┤                          │
│                      │                    │                          │
│  DefaultProtection ──┤── reads InvestorRegistry                      │
│       │              │── uses PUSDC (same transfer pattern)          │
│       │              │── creates ReineiraOS escrows                  │
│       │              └── uses YieldGate for claim conditions         │
│       │                                                              │
│       ├── triggered by EncryptedGovernance (fallback)                │
│       │                                                              │
│  EncryptedGovernance                                                 │
│       │── reads MuHavenToken balances (via getBalanceForGovernance)  │
│       │── reads InvestorRegistry (voter eligibility)                 │
│       └── calls DefaultProtection.triggerPayout()                    │
│                                                                      │
│  KYCAttestationRegistry ──── reads ERC3643KYCAdapter                 │
│                              tracks nonces + revocations             │
│                                                                      │
│  MuHavenKYCVerifier (destination chain)                              │
│       └── implements IKYCGate (drop-in verifier)                     │
└───────────────────────────────────────────────────────────────────────┘
```

### Integration Matrix

| New Contract | Reads From | Writes To | Called By |
|---|---|---|---|
| DefaultProtection | InvestorRegistry, PUSDC | ReineiraOS Escrow | Issuers (deposit reserve), Governance/Admin (trigger), Anyone (processBatch) |
| EncryptedGovernance | MuHavenToken (balances + totalSupply), InvestorRegistry | DefaultProtection | Investors (vote), Anyone (tally/execute) |
| KYCAttestationRegistry | ERC3643KYCAdapter | — | Backend (prepare attestation data) |
| MuHavenKYCVerifier | — | internal cache | Anyone (submit attestation), Protocols (isEligible) |

### Deployment Order

1. Deploy DefaultProtection proxy (depends on: InvestorRegistry, ReineiraEscrow, YieldGate, PUSDC)
2. Deploy EncryptedGovernance proxy (depends on: MuHavenToken, InvestorRegistry, DefaultProtection)
3. Wire: `DefaultProtection.setAuthorizedTrigger(governanceAddress, true)`
4. Wire: `MuHavenToken.setAuthorizedReader(governanceAddress, true)`
5. Deploy KYCAttestationRegistry (depends on: ERC3643KYCAdapter)
6. Deploy MuHavenKYCVerifier on destination chain(s)

---

## 3. Credit Default Protection (P0)

### 3.1 Interface: IDefaultProtection.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint128, InEuint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title IDefaultProtection
/// @notice Interface for the credit default protection module.
///         Issuers deposit PUSDC first-loss reserves; payouts trigger
///         automatically or via encrypted governance vote.
interface IDefaultProtection {

    // ── Events ───────────────────────────────────────────────────────

    event ProtectionCreated(
        uint256 indexed protectionId,
        address indexed token,
        address indexed issuer,
        uint256 reserveRateBps
    );

    event ReserveDeposited(
        uint256 indexed protectionId,
        address indexed depositor
    );

    event ReserveTopUp(
        uint256 indexed protectionId,
        address indexed depositor
    );

    event PayoutTriggered(
        uint256 indexed protectionId,
        address indexed triggeredBy,
        uint256 investorCount
    );

    event PayoutBatchProcessed(
        uint256 indexed protectionId,
        uint256 processedCount,
        uint256 investorCount
    );

    event PayoutCompleted(uint256 indexed protectionId);

    event MinimumReserveRateUpdated(uint256 newMinBps);
    event AuthorizedTriggerUpdated(address indexed trigger, bool authorized);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Views ────────────────────────────────────────────────────────

    /// @notice Returns the protection config for a given ID.
    function getProtection(uint256 protectionId) external view returns (
        address token,
        address issuer,
        uint256 reserveRateBps,
        euint128 encReserveBalance,
        uint8 status,
        uint256 createdAt,
        uint256 triggeredAt
    );

    /// @notice Returns the protection ID for a given MuHavenToken address.
    function tokenProtection(address token) external view returns (uint256);

    /// @notice Returns the protocol-wide minimum reserve rate in basis points.
    function minimumReserveRateBps() external view returns (uint256);

    /// @notice Returns whether a payout distribution is complete.
    function isPayoutComplete(uint256 protectionId) external view returns (bool);

    // ── Issuer functions ─────────────────────────────────────────────

    /// @notice Create a protection config for a MuHavenToken.
    ///         One protection per token. Rate must be >= minimumReserveRateBps.
    function createProtection(
        address token,
        uint256 reserveRateBps
    ) external returns (uint256 protectionId);

    /// @notice Deposit PUSDC into the reserve for an existing protection.
    ///         Caller must have granted operator status to this contract on PUSDC.
    function depositReserve(
        uint256 protectionId,
        InEuint64 memory encryptedAmount
    ) external;

    /// @notice Top up an existing reserve with additional PUSDC.
    function topUpReserve(
        uint256 protectionId,
        InEuint64 memory encryptedAmount
    ) external;

    // ── Trigger functions ────────────────────────────────────────────

    /// @notice Trigger a protection payout. Callable by owner, authorized
    ///         triggers (governance contract), or the token's issuer.
    function triggerPayout(uint256 protectionId) external;

    /// @notice Process a batch of investors for a triggered payout.
    ///         Permissionless — anyone can call to advance distribution.
    function processPayoutBatch(
        uint256 protectionId,
        uint256 batchSize
    ) external;

    // ── Admin functions ──────────────────────────────────────────────

    function setMinimumReserveRate(uint256 newMinBps) external;
    function setAuthorizedTrigger(address trigger, bool authorized) external;
    function transferOwnership(address newOwner) external;
}
```

### 3.2 Contract: DefaultProtection.sol

#### Inheritance

```
DefaultProtection
  ├── Initializable (OZ upgradeable)
  ├── ERC165Upgradeable (OZ upgradeable)
  ├── ReentrancyGuardTransient (OZ v5)
  └── IDefaultProtection
```

#### Storage Layout

```solidity
// ── Enums ────────────────────────────────────────────────────────

/// @dev Protection lifecycle: INACTIVE → ACTIVE → TRIGGERED → DISTRIBUTING → COMPLETED
enum ProtectionStatus { INACTIVE, ACTIVE, TRIGGERED, DISTRIBUTING, COMPLETED }

/// @dev Payout batch status (mirrors YieldDistributor.DistributionStatus)
enum PayoutStatus { PENDING, IN_PROGRESS, COMPLETED }

// ── Structs ──────────────────────────────────────────────────────

struct ProtectionConfig {
    address token;              // MuHavenToken address
    address issuer;             // Issuer who created this protection
    uint256 reserveRateBps;     // Public: reserve rate in basis points (e.g., 500 = 5%)
    euint128 encReserveBalance; // Encrypted: PUSDC reserve balance (widened from euint64)
    ProtectionStatus status;    // Lifecycle state
    uint256 createdAt;          // Block timestamp of creation
    uint256 triggeredAt;        // Block timestamp when triggered (0 if not triggered)
}

struct PayoutDistribution {
    uint256 protectionId;           // Link to ProtectionConfig
    euint128 encTotalPayout;        // Encrypted total payout (= encReserveBalance at trigger time)
    euint128 encPerInvestorPayout;  // Encrypted per-investor share: FHE.div(total, count)
    uint256 investorCount;          // Snapshot at trigger time
    uint256 processedCount;         // Investors processed so far
    uint256 escrowsCreated;         // Escrows successfully created
    PayoutStatus status;            // Batch progress state
}

// ── Storage slots ────────────────────────────────────────────────
//
// Slot layout follows OZ upgradeable conventions.
// Initializable and ERC165Upgradeable occupy their own reserved slots.
// Custom storage starts after inherited base slots.

mapping(uint256 => ProtectionConfig) public protections;    // Protection configs by ID
mapping(address => uint256) public tokenProtection;          // token address → protectionId
uint256 public protectionCount;                              // Counter (IDs start at 1)
uint256 public minimumReserveRateBps;                        // Protocol minimum (default: 300 = 3%)

mapping(uint256 => PayoutDistribution) public payoutDistributions; // Payout state by protectionId
euint128 private _encTotalReservesHeld;                      // Encrypted aggregate reserves

IInvestorRegistry public registry;          // Investor enumeration
IReineiraEscrow public reineiraEscrow;      // ReineiraOS escrow for payouts
address public yieldGate;                   // YieldGate (reused for payout escrow conditions)
IFHERC20 public pusdc;                      // PUSDC token (ConfidentialUSDC)

address public owner;
mapping(address => bool) public authorizedTriggers;  // Governance contract, admin addresses

/// @dev Reserved storage for future upgrades (proxy-safe gap)
uint256[50] private __gap;
```

#### Constants

```solidity
/// @dev Maximum reserve rate: 50% (5000 bps). Prevents misconfiguration.
uint256 public constant MAX_RESERVE_RATE_BPS = 5000;

/// @dev Selector for confidentialTransferFrom(address,address,uint256).
///      Matches deployed ConfidentialUSDC (pre-v0.1.0 cofhe-contracts).
///      Same constant as YieldDistributor._TRANSFER_FROM_UINT256.
bytes4 private constant _TRANSFER_FROM_UINT256 =
    bytes4(keccak256("confidentialTransferFrom(address,address,uint256)"));
```

#### Events

```solidity
event ProtectionCreated(uint256 indexed protectionId, address indexed token, address indexed issuer, uint256 reserveRateBps);
event ReserveDeposited(uint256 indexed protectionId, address indexed depositor);
event ReserveTopUp(uint256 indexed protectionId, address indexed depositor);
event PayoutTriggered(uint256 indexed protectionId, address indexed triggeredBy, uint256 investorCount);
event PayoutBatchProcessed(uint256 indexed protectionId, uint256 processedCount, uint256 investorCount);
event PayoutCompleted(uint256 indexed protectionId);
event MinimumReserveRateUpdated(uint256 newMinBps);
event AuthorizedTriggerUpdated(address indexed trigger, bool authorized);
event ReineiraEscrowUpdated(address indexed newEscrow);
event YieldGateUpdated(address indexed newGate);
event PusdcUpdated(address indexed newPusdc);
event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
```

#### Errors

```solidity
error OnlyOwner();
error OnlyIssuer();
error Unauthorized();
error ZeroAddress();
error RateBelowMinimum();          // reserveRateBps < minimumReserveRateBps
error RateAboveMaximum();          // reserveRateBps > MAX_RESERVE_RATE_BPS
error ProtectionAlreadyExists();   // tokenProtection[token] != 0
error ProtectionNotActive();       // status != ACTIVE
error ProtectionNotTriggered();    // status != TRIGGERED / DISTRIBUTING
error InvalidProtection();         // protectionId == 0 or > protectionCount
error PayoutAlreadyCompleted();
error NoInvestors();
error PusdcTransferFailed();
```

#### Functions

```solidity
// ── Initializer ──────────────────────────────────────────────────

/// @notice Initialize the proxy. Called once by the deploy script.
/// @param _registry          InvestorRegistry address
/// @param _reineiraEscrow    ReineiraOS escrow contract (or mock)
/// @param _yieldGate         YieldGate address (reused for payout escrow conditions)
/// @param _pusdc             PUSDC (ConfidentialUSDC) address
/// @param _owner             Initial owner
/// @param _minimumRateBps    Initial minimum reserve rate (e.g., 300 = 3%)
function initialize(
    address _registry,
    address _reineiraEscrow,
    address _yieldGate,
    address _pusdc,
    address _owner,
    uint256 _minimumRateBps
) external initializer;

// ── Issuer functions ─────────────────────────────────────────────

/// @notice Create a protection config for a MuHavenToken.
///         One protection per token. Issuer declares the reserve rate.
///         After creation, issuer must call depositReserve() to fund it.
///
///         Access: anyone can create (issuer address is recorded).
///         Rate: must be >= minimumReserveRateBps and <= MAX_RESERVE_RATE_BPS.
///         Status: starts as INACTIVE until reserve is deposited.
///
/// @param token           MuHavenToken address
/// @param reserveRateBps  Reserve rate in basis points (e.g., 500 = 5%)
/// @return protectionId   Starts at 1
function createProtection(
    address token,
    uint256 reserveRateBps
) external returns (uint256 protectionId);

/// @notice Deposit PUSDC into the reserve, activating the protection.
///         Caller must have granted this contract operator status on PUSDC
///         via pusdc.setOperator(address(this), expiry).
///
///         PUSDC transfer uses the uint256 selector for ConfidentialUSDC
///         compatibility (same pattern as YieldDistributor).
///
///         Access: only the protection's issuer.
///         Status transition: INACTIVE → ACTIVE on first deposit.
///
///         FHE patterns:
///         - FHE.asEuint64(encryptedAmount) converts client input
///         - FHE.asEuint128(euint64) widens for internal storage
///         - FHE.allowThis() on all new handles
///         - FHE.allow(reserve, issuer) grants issuer decrypt access
///
/// @param protectionId     Protection to fund
/// @param encryptedAmount  Client-encrypted PUSDC amount (InEuint64)
function depositReserve(
    uint256 protectionId,
    InEuint64 memory encryptedAmount
) external;

/// @notice Top up an existing active reserve with additional PUSDC.
///         Same transfer mechanics as depositReserve().
///         Access: only the protection's issuer.
///         Status: must be ACTIVE.
///
/// @param protectionId     Protection to top up
/// @param encryptedAmount  Client-encrypted additional PUSDC (InEuint64)
function topUpReserve(
    uint256 protectionId,
    InEuint64 memory encryptedAmount
) external;

// ── Trigger functions ────────────────────────────────────────────

/// @notice Trigger a protection payout. Creates a PayoutDistribution
///         and snapshots the investor count from the registry.
///
///         Access: owner, authorized triggers (governance), or the issuer.
///         Status transition: ACTIVE → TRIGGERED.
///         The full reserve balance becomes the payout amount.
///
///         FHE patterns:
///         - FHE.div(encReserveBalance, investorCount) for equal split
///         - FHE.allowThis() on per-investor share handle
///
/// @param protectionId  Protection to trigger
function triggerPayout(uint256 protectionId) external;

/// @notice Process a batch of investors for a triggered payout.
///         Creates ReineiraOS escrows with encrypted per-investor shares.
///         Permissionless — anyone (issuer, agent, relayer) can call.
///
///         Mirrors YieldDistributor.processBatch() exactly:
///         - Reads investors from registry via getInvestorsPaginated
///         - Creates escrow per investor with YieldGate condition
///         - Grants FHE.allow(encAmount, investor) for decrypt access
///
///         Status transition: TRIGGERED → DISTRIBUTING (on first batch)
///                            DISTRIBUTING → COMPLETED (on final batch)
///
/// @param protectionId  Protection being distributed
/// @param batchSize     Max investors to process in this call
function processPayoutBatch(
    uint256 protectionId,
    uint256 batchSize
) external;

// ── Async decrypt ────────────────────────────────────────────────

/// @notice Request async decryption of a protection's reserve balance.
///         Only the issuer or owner can decrypt.
function requestReserveDecrypt(uint256 protectionId) external;

/// @notice Read the async-decrypted reserve balance.
function getReserveDecryptResult(uint256 protectionId) external view returns (
    uint128 reserveBalance,
    bool decrypted
);

// ── Views ────────────────────────────────────────────────────────

function getProtection(uint256 protectionId) external view returns (
    address token,
    address issuer,
    uint256 reserveRateBps,
    euint128 encReserveBalance,
    uint8 status,
    uint256 createdAt,
    uint256 triggeredAt
);

function getPayoutDistribution(uint256 protectionId) external view returns (
    euint128 encTotalPayout,
    euint128 encPerInvestorPayout,
    uint256 investorCount,
    uint256 processedCount,
    uint256 escrowsCreated,
    uint8 status
);

function isPayoutComplete(uint256 protectionId) external view returns (bool);

// ── Admin ────────────────────────────────────────────────────────

function setMinimumReserveRate(uint256 newMinBps) external;  // onlyOwner
function setAuthorizedTrigger(address trigger, bool authorized) external;  // onlyOwner
function setReineiraEscrow(address newEscrow) external;  // onlyOwner
function setYieldGate(address newGate) external;  // onlyOwner
function setPusdc(address newPusdc) external;  // onlyOwner
function transferOwnership(address newOwner) external;  // onlyOwner
```

#### FHE Patterns Applied

| # | Pattern | Where |
|---|---|---|
| 1 | Access control before FHE ops | KYC/role checks before any `FHE.*` call in deposit/trigger/batch |
| 2 | Async decrypt | `requestReserveDecrypt` → `createDecryptTask` → `getDecryptResultSafe` |
| 3 | Silent failure with `FHE.select` | Not needed — protection payouts use equal split, no balance check |
| 4 | Permit-based decryption with `FHE.allow` | `FHE.allow(encAmount, investor)` in processBatch for each investor |
| 5 | Optional public reveal | Reserve rate is plaintext (public by design); reserve balance stays encrypted |

### 3.3 Data Flows

#### Reserve Deposit Flow

```
Issuer (EOA)                    DefaultProtection               PUSDC
    │                                  │                          │
    │ pusdc.setOperator(protection, ∞) │                          │
    │──────────────────────────────────┼─────────────────────────►│
    │                                  │                          │
    │ depositReserve(id, InEuint64)    │                          │
    │─────────────────────────────────►│                          │
    │                                  │ FHE.asEuint64(input)     │
    │                                  │ FHE.allow(amt, pusdc)    │
    │                                  │                          │
    │                                  │ confidentialTransferFrom │
    │                                  │─────────────────────────►│
    │                                  │                          │
    │                                  │ FHE.asEuint128(euint64)  │
    │                                  │ FHE.allowThis(reserve)   │
    │                                  │ FHE.allow(reserve, issuer)
    │                                  │                          │
    │                                  │ status = ACTIVE          │
    │                                  │ emit ReserveDeposited    │
    │◄─────────────────────────────────│                          │
```

#### Payout Trigger + Distribution Flow

```
Governance/Admin                DefaultProtection          InvestorRegistry   ReineiraOS Escrow
    │                                  │                         │                   │
    │ triggerPayout(protectionId)       │                         │                   │
    │─────────────────────────────────►│                         │                   │
    │                                  │ investorCount()         │                   │
    │                                  │────────────────────────►│                   │
    │                                  │◄────────────────────────│                   │
    │                                  │                         │                   │
    │                                  │ FHE.div(reserve, count) │                   │
    │                                  │ status = TRIGGERED      │                   │
    │                                  │ emit PayoutTriggered    │                   │
    │◄─────────────────────────────────│                         │                   │
    │                                  │                         │                   │
Anyone                                 │                         │                   │
    │ processPayoutBatch(id, 50)       │                         │                   │
    │─────────────────────────────────►│                         │                   │
    │                                  │ getInvestorsPaginated   │                   │
    │                                  │────────────────────────►│                   │
    │                                  │◄────────────────────────│                   │
    │                                  │                         │                   │
    │                                  │ for each investor:      │                   │
    │                                  │   FHE.allow(amt, inv)   │                   │
    │                                  │   escrow.create(inv, amt, gate)            │
    │                                  │───────────────────────────────────────────►│
    │                                  │                         │                   │
    │                                  │ if all processed:       │                   │
    │                                  │   status = COMPLETED    │                   │
    │                                  │   emit PayoutCompleted  │                   │
    │◄─────────────────────────────────│                         │                   │
```

---

## 4. Encrypted Governance (P0)

### 4.1 Interface: IEncryptedGovernance.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint128, InEuint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title IEncryptedGovernance
/// @notice Interface for FHE-encrypted ballot voting. Investors vote on
///         proposals using encrypted ballots — nobody can see individual
///         votes. Vote weight equals the voter's encrypted token balance.
///
///         Primary use case: force-triggering default protection payouts
///         when an issuer is uncooperative (won't call windDown).
interface IEncryptedGovernance {

    // ── Events ───────────────────────────────────────────────────────

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed token,
        uint8 proposalType,
        address indexed proposer,
        uint256 votingEnd
    );

    event VoteCast(
        uint256 indexed proposalId,
        address indexed voter
        // Vote direction and weight are NOT emitted (encrypted)
    );

    event TallyRequested(uint256 indexed proposalId);

    event ProposalExecuted(
        uint256 indexed proposalId,
        bool passed
    );

    event ProposalExpired(uint256 indexed proposalId);

    event VotingPeriodUpdated(uint256 newPeriodSeconds);
    event QuorumBpsUpdated(uint256 newQuorumBps);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Views ────────────────────────────────────────────────────────

    function getProposal(uint256 proposalId) external view returns (
        address token,
        uint8 proposalType,
        address proposer,
        uint256 votingStart,
        uint256 votingEnd,
        uint256 voterCount,
        uint8 status
    );

    function hasVoted(uint256 proposalId, address voter) external view returns (bool);
    function proposalCount() external view returns (uint256);
    function votingPeriodSeconds() external view returns (uint256);
    function quorumBps() external view returns (uint256);

    // ── Actions ──────────────────────────────────────────────────────

    /// @notice Create a proposal targeting a specific MuHavenToken.
    function createProposal(
        address token,
        uint8 proposalType
    ) external returns (uint256 proposalId);

    /// @notice Cast an encrypted vote on a proposal.
    ///         Vote is encrypted as euint128: 0 = no, nonzero = yes.
    ///         Weight equals voter's encrypted token balance.
    function castVote(
        uint256 proposalId,
        InEuint128 memory encryptedVote
    ) external;

    /// @notice Request async decryption of the tally result.
    ///         Callable after the voting period ends.
    function requestTally(uint256 proposalId) external;

    /// @notice Read the tally result and execute if passed.
    ///         Callable after async decrypt completes.
    function executeProposal(uint256 proposalId) external;

    // ── Admin ────────────────────────────────────────────────────────

    function setVotingPeriod(uint256 newPeriodSeconds) external;
    function setQuorumBps(uint256 newQuorumBps) external;
    function transferOwnership(address newOwner) external;
}
```

### 4.2 Contract: EncryptedGovernance.sol

#### Inheritance

```
EncryptedGovernance
  ├── Initializable (OZ upgradeable)
  ├── ERC165Upgradeable (OZ upgradeable)
  └── IEncryptedGovernance
```

#### Storage Layout

```solidity
// ── Enums ────────────────────────────────────────────────────────

/// @dev Proposal types. Extensible for future governance actions.
enum ProposalType {
    FORCE_PROTECTION_TRIGGER   // 0: Force DefaultProtection.triggerPayout()
    // Future: DELIST_TOKEN, CHANGE_RISK_PARAMS, CHANGE_FEE, etc.
}

/// @dev Proposal lifecycle: ACTIVE → TALLY_REQUESTED → EXECUTED / DEFEATED / EXPIRED
enum ProposalStatus {
    ACTIVE,           // Voting in progress
    TALLY_REQUESTED,  // Voting ended, async decrypt in progress
    EXECUTED,         // Passed and executed
    DEFEATED,         // Did not reach quorum
    EXPIRED           // Voting period ended, no tally requested within grace period
}

// ── Structs ──────────────────────────────────────────────────────

struct Proposal {
    address token;              // Target MuHavenToken
    ProposalType proposalType;  // What action to take if passed
    address proposer;           // Who created the proposal
    uint256 votingStart;        // block.timestamp at creation
    uint256 votingEnd;          // votingStart + votingPeriodSeconds

    euint128 encTotalYesWeight;    // Encrypted: sum of yes-voter balances
    euint128 encTotalSupplySnapshot; // Encrypted: total supply at proposal creation

    // Tally result handle (intermediate — used for async decrypt)
    euint128 encTallyResult;    // FHE.select(passed, 1, 0) as euint128

    uint256 voterCount;         // Number of voters (cleartext, no privacy concern)
    ProposalStatus status;
}

// ── Storage slots ────────────────────────────────────────────────

mapping(uint256 => Proposal) public proposals;
mapping(uint256 => mapping(address => bool)) public hasVoted;  // proposalId → voter → voted?
uint256 public proposalCount;

uint256 public votingPeriodSeconds;  // Default: 7 days (604800)
uint256 public quorumBps;            // Default: 5000 (50% of total supply)

IMuHavenToken public muhavenToken;
IDefaultProtection public defaultProtection;
IInvestorRegistry public registry;

address public owner;

/// @dev Reserved storage for future upgrades (proxy-safe gap)
uint256[50] private __gap;
```

#### Events

```solidity
event ProposalCreated(uint256 indexed proposalId, address indexed token, uint8 proposalType, address indexed proposer, uint256 votingEnd);
event VoteCast(uint256 indexed proposalId, address indexed voter);
event TallyRequested(uint256 indexed proposalId);
event ProposalExecuted(uint256 indexed proposalId, bool passed);
event ProposalExpired(uint256 indexed proposalId);
event VotingPeriodUpdated(uint256 newPeriodSeconds);
event QuorumBpsUpdated(uint256 newQuorumBps);
event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
```

#### Errors

```solidity
error OnlyOwner();
error ZeroAddress();
error InvalidProposal();         // proposalId == 0 or > proposalCount
error VotingNotActive();          // status != ACTIVE or period ended
error VotingNotEnded();           // block.timestamp < votingEnd
error AlreadyVoted();             // hasVoted[proposalId][msg.sender]
error NotRegisteredInvestor();    // !registry.isInvestor(msg.sender)
error ProposalNotTallyable();    // status != ACTIVE or not past votingEnd
error TallyNotReady();            // async decrypt not completed
error ProposalAlreadyResolved();  // status is EXECUTED, DEFEATED, or EXPIRED
error InvalidVotingPeriod();      // period == 0
error InvalidQuorum();            // quorum == 0 or > 10000
error NoProtectionForToken();     // DefaultProtection has no protection for this token
```

#### Functions

```solidity
// ── Initializer ──────────────────────────────────────────────────

/// @notice Initialize the proxy.
/// @param _muhavenToken       MuHavenToken address (must have authorized this contract as reader)
/// @param _defaultProtection  DefaultProtection address (this contract will be an authorized trigger)
/// @param _registry           InvestorRegistry address
/// @param _owner              Initial owner
/// @param _votingPeriod       Voting period in seconds (e.g., 604800 = 7 days)
/// @param _quorumBps          Quorum threshold in basis points (e.g., 5000 = 50%)
function initialize(
    address _muhavenToken,
    address _defaultProtection,
    address _registry,
    address _owner,
    uint256 _votingPeriod,
    uint256 _quorumBps
) external initializer;

// ── Proposal lifecycle ───────────────────────────────────────────

/// @notice Create a governance proposal targeting a MuHavenToken.
///
///         Access: any registered investor.
///         Precondition: DefaultProtection must have an active protection
///         for the target token.
///
///         FHE patterns:
///         - Snapshots encrypted total supply via muhavenToken.getTotalSupplyForGovernance()
///         - FHE.allowThis(totalSupply) for later quorum comparison
///         - Initializes encTotalYesWeight to FHE.asEuint128(0)
///
/// @param token          MuHavenToken to target
/// @param proposalType   0 = FORCE_PROTECTION_TRIGGER
/// @return proposalId    Starts at 1
function createProposal(
    address token,
    uint8 proposalType
) external returns (uint256 proposalId);

/// @notice Cast an encrypted vote on an active proposal.
///
///         Access: registered investors who haven't voted on this proposal.
///         Voting period: block.timestamp must be between votingStart and votingEnd.
///
///         Vote encoding: client encrypts 0 (no) or 1+ (yes) as euint128.
///         Weight: voter's encrypted token balance from MuHavenToken.
///
///         FHE operations:
///         1. vote = FHE.asEuint128(encryptedVote)
///         2. isYes = FHE.gte(vote, FHE.asEuint128(1))
///         3. voterBalance = muhavenToken.getBalanceForGovernance(msg.sender)
///            (This call grants FHE.allow(balance, address(this)))
///         4. weightedVote = FHE.select(isYes, voterBalance, FHE.asEuint128(0))
///         5. encTotalYesWeight = FHE.add(encTotalYesWeight, weightedVote)
///         6. FHE.allowThis(encTotalYesWeight)
///
///         Privacy: nobody can see individual votes or weights.
///         Side-channel resistance: same gas cost for yes/no (FHE.select pattern).
///
/// @param proposalId     Proposal to vote on
/// @param encryptedVote  Encrypted vote: 0 = no, 1+ = yes (InEuint128)
function castVote(
    uint256 proposalId,
    InEuint128 memory encryptedVote
) external;

/// @notice Request async decryption of the tally result.
///         Callable by anyone after the voting period ends.
///
///         FHE operations:
///         1. threshold = FHE.div(encTotalSupplySnapshot, FHE.asEuint128(10000))
///         2. threshold = FHE.mul(threshold, FHE.asEuint128(quorumBps))
///            (quorumBps/10000 of total supply)
///         3. passed = FHE.gte(encTotalYesWeight, threshold)
///         4. encTallyResult = FHE.select(passed, FHE.asEuint128(1), FHE.asEuint128(0))
///         5. FHE.allowThis(encTallyResult)
///         6. ITaskManager.createDecryptTask(encTallyResult)
///
///         Status transition: ACTIVE → TALLY_REQUESTED
///
/// @param proposalId  Proposal to tally
function requestTally(uint256 proposalId) external;

/// @notice Read the tally result and execute the proposal if it passed.
///         Callable by anyone after async decrypt completes.
///
///         Reads: FHE.getDecryptResultSafe(encTallyResult) → (uint128, bool)
///         If result == 1: proposal passed → call defaultProtection.triggerPayout()
///         If result == 0: proposal defeated.
///
///         Status transition:
///         - Passed: TALLY_REQUESTED → EXECUTED
///         - Failed: TALLY_REQUESTED → DEFEATED
///
/// @param proposalId  Proposal to execute
function executeProposal(uint256 proposalId) external;

// ── Views ────────────────────────────────────────────────────────

function getProposal(uint256 proposalId) external view returns (
    address token,
    uint8 proposalType,
    address proposer,
    uint256 votingStart,
    uint256 votingEnd,
    uint256 voterCount,
    uint8 status
);

function hasVoted(uint256 proposalId, address voter) external view returns (bool);

// ── Admin ────────────────────────────────────────────────────────

function setVotingPeriod(uint256 newPeriodSeconds) external;  // onlyOwner
function setQuorumBps(uint256 newQuorumBps) external;  // onlyOwner
function transferOwnership(address newOwner) external;  // onlyOwner
```

#### FHE Patterns Applied

| # | Pattern | Where |
|---|---|---|
| 1 | Access control before FHE ops | Registry/voter checks before FHE operations in castVote |
| 2 | Async decrypt | requestTally → createDecryptTask → getDecryptResultSafe in executeProposal |
| 3 | Silent failure with `FHE.select` | Vote weight: `FHE.select(isYes, balance, zero)` — same gas for yes/no |
| 4 | Permit-based decryption with `FHE.allow` | Not needed — tally result is decrypted on-chain, not by individuals |
| 5 | Optional public reveal | Tally result revealed via async decrypt only after voting ends |

#### Vote Weight: Why FHE.select, not FHE.mul

```
Option A (FHE.mul): weightedVote = FHE.mul(vote, balance)
  - Requires cross-type or same-type multiplication
  - vote must be same type as balance (euint128)
  - Risk: voter could submit vote=2 to double their weight

Option B (FHE.select): weightedVote = FHE.select(isYes, balance, zero)   ← CHOSEN
  - Binary: either full balance weight or zero
  - No multiplication needed
  - Immune to vote value manipulation (any nonzero = yes)
  - Follows existing MuHavenToken transfer pattern exactly
  - Same gas cost for yes/no (side-channel resistant)
```

### 4.3 Data Flows

#### Proposal Creation + Voting + Execution

```
Investor A                  EncryptedGovernance          MuHavenToken     DefaultProtection
    │                              │                          │                │
    │ createProposal(token, 0)     │                          │                │
    │─────────────────────────────►│                          │                │
    │                              │ getTotalSupplyForGov()   │                │
    │                              │─────────────────────────►│                │
    │                              │◄─────────────────────────│                │
    │                              │ FHE.allowThis(supply)    │                │
    │                              │ init encTotalYesWeight=0  │                │
    │                              │ emit ProposalCreated     │                │
    │◄─────────────────────────────│                          │                │
    │                              │                          │                │
    │ castVote(id, InEuint128(1))  │                          │                │
    │─────────────────────────────►│                          │                │
    │                              │ FHE.asEuint128(vote)     │                │
    │                              │ FHE.gte(vote, 1) → isYes │                │
    │                              │ getBalanceForGov(voterA)  │                │
    │                              │─────────────────────────►│                │
    │                              │◄─────────────────────────│                │
    │                              │ FHE.select(isYes, bal, 0) │                │
    │                              │ FHE.add(totalYes, weight) │                │
    │                              │ emit VoteCast            │                │
    │◄─────────────────────────────│                          │                │
    │                              │                          │                │
    ... (more investors vote) ...  │                          │                │
    │                              │                          │                │
    │ requestTally(id)             │                          │                │
    │─────────────────────────────►│                          │                │
    │                              │ threshold = supply * quorum / 10000     │
    │                              │ passed = FHE.gte(totalYes, threshold)    │
    │                              │ result = FHE.select(passed, 1, 0)       │
    │                              │ createDecryptTask(result) │                │
    │◄─────────────────────────────│                          │                │
    │                              │                          │                │
    │ ... wait for CoFHE ...       │                          │                │
    │                              │                          │                │
    │ executeProposal(id)          │                          │                │
    │─────────────────────────────►│                          │                │
    │                              │ getDecryptResultSafe     │                │
    │                              │ result == 1 → PASSED     │                │
    │                              │ triggerPayout(protectionId)│               │
    │                              │────────────────────────────────────────►│
    │                              │ status = EXECUTED        │                │
    │                              │ emit ProposalExecuted(true)              │
    │◄─────────────────────────────│                          │                │
```

---

## 5. Cross-Chain KYC Attestation (P1 — Design + Stubs)

### 5.1 Contract: KYCAttestationRegistry.sol (Source Chain)

**Pattern:** Non-proxied (like ERC3643KYCAdapter and YieldGate). Deployed as a companion to the KYC adapter.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title KYCAttestationRegistry
/// @notice Tracks attestation metadata (nonces, revocations, jurisdiction)
///         on the source chain. The actual EIP-712 signing happens off-chain
///         by the attestation signer's backend.
///
///         Flow:
///         1. Backend calls prepareAttestation(investor) → reads KYC status
///         2. Backend signs the attestation data with EIP-712
///         3. Investor receives signed attestation
///         4. Investor submits attestation to MuHavenKYCVerifier on destination chain
contract KYCAttestationRegistry {

    // ── Structs ──────────────────────────────────────────────────────

    struct AttestationData {
        address investor;
        bool isVerified;         // KYC verified (tier 1+)
        uint8 tier;              // 0=none, 1=retail, 2=accredited
        bytes32 jurisdictionHash; // keccak256 of jurisdiction string (privacy-preserving)
        uint256 nonce;           // Monotonic — incremented on revocation
        uint256 issuedAt;        // block.timestamp at preparation
        uint256 expiresAt;       // issuedAt + defaultValidityPeriod
    }

    // ── Storage ──────────────────────────────────────────────────────

    IKYCGate public kycGate;                    // ERC3643KYCAdapter (or any IKYCGate)
    address public attestationSigner;           // Address whose private key signs attestations
    uint256 public sourceChainId;               // For EIP-712 domain separator
    uint256 public defaultValidityPeriod;       // Default: 90 days (7776000 seconds)

    mapping(address => uint256) public nonces;               // Per-investor nonce
    mapping(address => mapping(uint256 => bool)) public revoked; // investor → nonce → revoked
    mapping(address => bytes32) public jurisdictionHashes;    // Set by admin

    address public admin;

    // ── Events ───────────────────────────────────────────────────────

    event AttestationPrepared(address indexed investor, uint256 nonce, uint256 expiresAt);
    event AttestationRevoked(address indexed investor, uint256 nonce);
    event JurisdictionUpdated(address indexed investor, bytes32 jurisdictionHash);
    event AttestationSignerUpdated(address indexed newSigner);
    event ValidityPeriodUpdated(uint256 newPeriod);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // ── Errors ───────────────────────────────────────────────────────

    error OnlyAdmin();
    error ZeroAddress();
    error AlreadyRevoked();

    // ── Functions ────────────────────────────────────────────────────

    constructor(address _kycGate, address _signer, address _admin);

    /// @notice Prepare attestation data for an investor.
    ///         Reads current KYC status from the adapter.
    ///         Does NOT increment nonce — signing backend calls this as a view.
    function prepareAttestation(address investor) external view returns (AttestationData memory);

    /// @notice Revoke an attestation by incrementing the investor's nonce.
    ///         All attestations with nonces < new nonce become invalid.
    function revokeAttestation(address investor) external;  // onlyAdmin

    /// @notice Check if a specific attestation (investor + nonce) is still valid.
    function isAttestationValid(address investor, uint256 nonce) external view returns (bool);

    /// @notice Set jurisdiction hash for an investor (privacy-preserving).
    function setJurisdictionHash(address investor, bytes32 hash) external;  // onlyAdmin

    /// @notice Batch set jurisdiction hashes.
    function batchSetJurisdictionHash(
        address[] calldata investors,
        bytes32[] calldata hashes
    ) external;  // onlyAdmin

    function setAttestationSigner(address newSigner) external;  // onlyAdmin
    function setDefaultValidityPeriod(uint256 newPeriod) external;  // onlyAdmin
    function transferAdmin(address newAdmin) external;  // onlyAdmin
}
```

### 5.2 Contract: MuHavenKYCVerifier.sol (Destination Chain)

**Pattern:** Non-proxied. Implements `IKYCGate` for drop-in compatibility with any protocol using MuHaven's KYC interface.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IKYCGate} from "./interfaces/IKYCGate.sol";

/// @title MuHavenKYCVerifier
/// @notice Verifies MuHaven KYC attestations on any EVM destination chain.
///         Implements IKYCGate — protocols can use this as a drop-in KYC gate
///         that accepts MuHaven-issued attestations instead of requiring
///         separate KYC onboarding.
///
///         Attestation flow:
///         1. Investor obtains EIP-712 signed attestation from MuHaven
///         2. Investor (or relayer) calls submitAttestation() with data + signature
///         3. Verifier checks signature against trustedSigner, caches result
///         4. Any protocol calls isEligible(investor) — returns cached status
contract MuHavenKYCVerifier is ERC165, IKYCGate {

    // ── Structs ──────────────────────────────────────────────────────

    struct CachedAttestation {
        bool isVerified;
        uint8 tier;              // 0=none, 1=retail, 2=accredited
        bytes32 jurisdictionHash;
        uint256 nonce;
        uint256 expiresAt;
        uint256 submittedAt;     // block.timestamp when submitted to this chain
    }

    // ── EIP-712 Constants ────────────────────────────────────────────

    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "KYCAttestation(address investor,bool isVerified,uint8 tier,bytes32 jurisdictionHash,uint256 nonce,uint256 issuedAt,uint256 expiresAt)"
    );

    // ── Storage ──────────────────────────────────────────────────────

    address public trustedSigner;           // MuHaven attestation authority address
    bytes32 public sourceDomainSeparator;   // Pre-computed for the source chain + registry
    address public admin;

    mapping(address => CachedAttestation) public cachedAttestations;

    // ── Events ───────────────────────────────────────────────────────

    event AttestationSubmitted(address indexed investor, uint8 tier, uint256 expiresAt);
    event AttestationInvalidated(address indexed investor);
    event TrustedSignerUpdated(address indexed newSigner);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // ── Errors ───────────────────────────────────────────────────────

    error OnlyAdmin();
    error ZeroAddress();
    error InvalidSignature();
    error AttestationExpired();
    error AttestationNotVerified();

    // ── Functions ────────────────────────────────────────────────────

    /// @param _trustedSigner       MuHaven attestation signer address
    /// @param _sourceChainId       Chain ID where KYCAttestationRegistry is deployed
    /// @param _sourceRegistryAddr  Address of KYCAttestationRegistry on source chain
    /// @param _admin               Admin address
    constructor(
        address _trustedSigner,
        uint256 _sourceChainId,
        address _sourceRegistryAddr,
        address _admin
    );

    /// @notice Submit a signed MuHaven KYC attestation. Verifies the EIP-712
    ///         signature and caches the result for isEligible() queries.
    ///
    ///         Anyone can submit (investor or relayer).
    ///         Overwrites any previous cached attestation for the investor.
    function submitAttestation(
        address investor,
        bool isVerified,
        uint8 tier,
        bytes32 jurisdictionHash,
        uint256 nonce,
        uint256 issuedAt,
        uint256 expiresAt,
        bytes calldata signature
    ) external;

    /// @notice Invalidate a cached attestation (e.g., after revocation on source chain).
    function invalidateAttestation(address investor) external;  // onlyAdmin

    // ── IKYCGate implementation ──────────────────────────────────────

    /// @notice Returns true if the investor has a valid, non-expired cached attestation.
    ///         Compatible with IKYCGate — drop-in replacement for ERC3643KYCAdapter.
    function isEligible(address account) external view returns (bool);

    /// @notice Tier check: tier 1 = retail KYC, tier 2 = accredited.
    function isEligibleForTier(address account, uint256 tier) external view returns (bool);

    /// @notice Returns "MuHaven Cross-Chain KYC (EIP-712 Attestation)".
    function providerName() external pure returns (string memory);

    // ── Views ────────────────────────────────────────────────────────

    function getCachedAttestation(address investor) external view returns (CachedAttestation memory);

    // ── Admin ────────────────────────────────────────────────────────

    function setTrustedSigner(address newSigner) external;  // onlyAdmin
    function transferAdmin(address newAdmin) external;  // onlyAdmin
}
```

### 5.3 EIP-712 Attestation Structure

```
EIP712Domain {
    name:              "MuHaven KYC Attestation"
    version:           "1"
    chainId:           <source chain ID (e.g., 421614 for Arb Sepolia)>
    verifyingContract: <KYCAttestationRegistry address on source chain>
}

KYCAttestation {
    investor:          address   // Investor wallet address
    isVerified:        bool      // KYC status (true = verified)
    tier:              uint8     // 0=none, 1=retail, 2=accredited
    jurisdictionHash:  bytes32   // keccak256("US"), keccak256("EU"), etc.
    nonce:             uint256   // Monotonic nonce (revocation tracking)
    issuedAt:          uint256   // Timestamp of attestation issuance
    expiresAt:         uint256   // Expiry timestamp (issuedAt + validityPeriod)
}
```

The `jurisdictionHash` uses a hash rather than a plaintext string for privacy: the destination chain verifier cannot determine the investor's jurisdiction unless it knows the preimage. This prevents jurisdiction-based discrimination while still allowing targeted verification (a protocol that only accepts US investors can check `hash == keccak256("US")`).

### 5.4 Cross-Chain Flow

```
SOURCE CHAIN (Arb Sepolia)                    DESTINATION CHAIN (any EVM)
─────────────────────────                     ─────────────────────────────

ERC3643KYCAdapter                              MuHavenKYCVerifier
    │                                              │
    │  KYCAttestationRegistry                      │
    │       │                                      │
    │       │ prepareAttestation(investor)          │
    │◄──────│                                      │
    │       │                                      │
    │  Backend (off-chain):                        │
    │  1. Read attestation data                    │
    │  2. Sign with EIP-712                        │
    │  3. Return signed attestation to investor    │
    │                                              │
    │       ┌──── Investor carries attestation ────┐
    │       │     (off-chain transfer, no bridge)  │
    │       │                                      │
    │       │   submitAttestation(data, signature) │
    │       │─────────────────────────────────────►│
    │       │                                      │ ecrecover → check trustedSigner
    │       │                                      │ cache attestation
    │       │                                      │
    │       │                                      │
    │       │   Any protocol:                      │
    │       │   verifier.isEligible(investor)      │
    │       │                                      │──► returns true/false
    │       │                                      │
    │       │   verifier.isEligibleForTier(inv, 2) │
    │       │                                      │──► returns true/false (accredited?)
```

**Key design decision:** No bridge infrastructure required. The attestation travels with the investor as a signed message. This is cheaper, simpler, and more resilient than CCIP/LayerZero-based approaches. The tradeoff is that revocation requires explicit invalidation on the destination chain (the admin must call `invalidateAttestation()` or the attestation naturally expires).

---

## 6. Required Modifications to Existing Contracts

### 6.1 MuHavenToken.sol

The EncryptedGovernance contract needs to read encrypted balances and total supply with `FHE.allow` access. This requires three new functions and one new storage variable in MuHavenToken.

#### New Storage (1 gap slot consumed)

```solidity
// After existing storage:
bool public totalSupplyPublic;

// NEW — governance integration:
mapping(address => bool) public authorizedReaders;  // Consumes 1 slot from __gap

// UPDATED gap:
uint256[49] private __gap;  // Was uint256[50], now 49
```

**Storage compatibility:** Adding `authorizedReaders` before `__gap` and reducing the gap from 50 to 49 is a standard proxy-safe upgrade pattern. The mapping occupies one base slot (its entries are stored at `keccak256(key . slot)`). No existing slot positions change.

#### New Events

```solidity
event AuthorizedReaderUpdated(address indexed reader, bool authorized);
```

#### New Functions

```solidity
/// @notice Grant or revoke a contract's permission to read encrypted balances
///         and total supply with FHE.allow access. Used by EncryptedGovernance.
/// @param reader      Contract address to authorize (e.g., governance)
/// @param authorized  true = grant, false = revoke
function setAuthorizedReader(address reader, bool authorized) external onlyOwner {
    if (reader == address(0)) revert ZeroAddress();
    authorizedReaders[reader] = authorized;
    emit AuthorizedReaderUpdated(reader, authorized);
}

/// @notice Returns an investor's encrypted balance and grants the caller
///         FHE.allow access to use it in FHE operations.
///
///         Access: only authorized readers (e.g., EncryptedGovernance).
///         FHE: calls FHE.allow(balance, msg.sender) so the caller contract
///         can use the handle in FHE.select, FHE.add, etc.
///
///         Note: This is NOT a view function because FHE.allow modifies
///         CoFHE coprocessor state (access control lists).
///
/// @param account  Investor address
/// @return balance Encrypted balance handle (caller has FHE access)
function getBalanceForGovernance(address account) external returns (euint128) {
    if (!authorizedReaders[msg.sender]) revert OnlyOwner();  // Reuse existing error
    euint128 balance = _balances[account];
    if (Common.isInitialized(balance)) {
        FHE.allow(balance, msg.sender);
    }
    return balance;
}

/// @notice Returns the encrypted total supply and grants the caller
///         FHE.allow access for quorum calculations.
///
///         Access: only authorized readers.
///
/// @return totalSupply  Encrypted total supply handle (caller has FHE access)
function getTotalSupplyForGovernance() external returns (euint128) {
    if (!authorizedReaders[msg.sender]) revert OnlyOwner();
    if (Common.isInitialized(_encryptedTotalSupply)) {
        FHE.allow(_encryptedTotalSupply, msg.sender);
    }
    return _encryptedTotalSupply;
}
```

#### IMuHavenToken.sol Extension

Add to the existing interface:

```solidity
// Governance integration
function setAuthorizedReader(address reader, bool authorized) external;
function getBalanceForGovernance(address account) external returns (euint128);
function getTotalSupplyForGovernance() external returns (euint128);
function authorizedReaders(address reader) external view returns (bool);
```

---

## 7. Security Considerations

### Default Protection

| Risk | Mitigation |
|---|---|
| **Reserve insufficiency** — issuer declares 5% but deposits less | Reserve balance is encrypted; admin/auditor can async-decrypt to verify. Production: on-chain verification via FHE comparison. |
| **Premature trigger** — admin accidentally triggers payout | No grace period in v1; production upgrade: add configurable grace period with cancel function. |
| **Double trigger** — triggerPayout called twice | Status check: only ACTIVE → TRIGGERED transition allowed. |
| **Batch processing DOS** — extremely large investor count | Batched processing (same as YieldDistributor). Gas per batch is bounded by batchSize. |
| **Reserve drain** — attacker finds way to withdraw reserve before trigger | No withdrawal function in v1. Reserve is locked until payout. |
| **Issuer front-runs trigger** — issuer withdraws tokens before governance can act | No withdrawal function prevents this. |

### Encrypted Governance

| Risk | Mitigation |
|---|---|
| **Flash-loan vote manipulation** — borrow tokens, vote, return | Mitigated by: (1) MuHaven tokens aren't in DeFi lending pools, (2) KYC requirement limits Sybil, (3) production upgrade: FHE-encrypted checkpoints |
| **Vote buying** — voter proves their vote to a buyer | FHE prevents vote proof: voter cannot demonstrate their vote direction to a third party. The encrypted vote is never decryptable by anyone except the contract. |
| **Quorum gaming** — whales block proposals by not voting | Quorum is based on total yes weight vs total supply, not voter participation. Abstention = implicit no. |
| **Proposal spam** — attacker creates many proposals | Mitigated by: only registered (KYC'd) investors can propose. Production: add proposal deposit requirement. |
| **Tally manipulation** — corrupted async decrypt | CoFHE threshold network provides security guarantees. Same trust model as all other FHE operations. |

### Cross-Chain KYC

| Risk | Mitigation |
|---|---|
| **Stale attestation** — investor loses KYC on source chain | Attestations have expiry dates. Admin can call invalidateAttestation(). |
| **Signer key compromise** — attacker forges attestations | Admin can update trustedSigner. Short validity periods limit exposure window. |
| **Replay across chains** — same attestation used on multiple chains | By design: attestations ARE valid across chains (that's the feature). Each chain independently caches and can invalidate. |
| **Jurisdiction privacy** — destination chain learns investor jurisdiction | jurisdictionHash uses keccak256 — preimage not revealed unless the verifier knows the hash-to-jurisdiction mapping. |

### Known Limitations (v1 / Hackathon)

1. **No balance snapshots for governance** — voter balance is read at vote time, not proposal creation time. Production upgrade: FHE-encrypted ERC-20 checkpoints.
2. **No reserve withdrawal** — issuer cannot reclaim reserve even after normal token lifecycle completion. Production upgrade: withdrawable after normal wind-down + grace period.
3. **No grace period on protection trigger** — payout begins immediately. Production upgrade: configurable grace period with admin cancel.
4. **Equal-split payouts** — same per-investor amount regardless of token balance (matches current YieldDistributor). Production upgrade: proportional payouts when FHE proportional math is available.
5. **Single proposal per token** — no concurrent proposals on the same token. Simplifies state management.
6. **KYC attestation revocation is manual** — admin must explicitly invalidate on each destination chain. Production upgrade: CCIP-based revocation broadcast.

---

## 8. Test Plan

### DefaultProtection.test.ts

| # | Test | Asserts |
|---|---|---|
| 1 | Create protection with valid rate | protectionId == 1, rate stored, status == INACTIVE |
| 2 | Reject rate below minimum | Reverts with RateBelowMinimum |
| 3 | Reject rate above maximum | Reverts with RateAboveMaximum |
| 4 | Reject duplicate protection for same token | Reverts with ProtectionAlreadyExists |
| 5 | Deposit reserve (PUSDC) | Status → ACTIVE, encrypted balance stored, FHE.allow(issuer) |
| 6 | Only issuer can deposit | Reverts with OnlyIssuer for other callers |
| 7 | Top up reserve | Encrypted balance increases (FHE.add), event emitted |
| 8 | Trigger payout (owner) | Status → TRIGGERED, payout distribution created, investor count snapshot |
| 9 | Trigger payout (governance) | Authorized trigger can call |
| 10 | Reject trigger from unauthorized | Reverts with Unauthorized |
| 11 | Reject trigger on non-active protection | Reverts with ProtectionNotActive |
| 12 | Process payout batch | Escrows created, processedCount advances, events emitted |
| 13 | Complete payout distribution | Status → COMPLETED after all investors processed |
| 14 | Async decrypt reserve balance | createDecryptTask → time.increase(11) → getDecryptResultSafe |
| 15 | Set minimum reserve rate | Only owner, new rate applied to future protections |
| 16 | EIP-165 supportsInterface | Returns true for IDefaultProtection |

### EncryptedGovernance.test.ts

| # | Test | Asserts |
|---|---|---|
| 1 | Create proposal | proposalId == 1, voting period set, status == ACTIVE |
| 2 | Only registered investors can propose | Reverts with NotRegisteredInvestor |
| 3 | Reject proposal for token without protection | Reverts with NoProtectionForToken |
| 4 | Cast encrypted yes vote | VoteCast emitted, hasVoted == true, voterCount incremented |
| 5 | Cast encrypted no vote | Same events, voterCount incremented (no observable difference) |
| 6 | Reject double vote | Reverts with AlreadyVoted |
| 7 | Reject vote after period ends | Reverts with VotingNotActive |
| 8 | Reject vote from non-investor | Reverts with NotRegisteredInvestor |
| 9 | Request tally after voting ends | Status → TALLY_REQUESTED, createDecryptTask called |
| 10 | Reject tally before voting ends | Reverts with VotingNotEnded |
| 11 | Execute passed proposal | getDecryptResultSafe returns 1, triggerPayout called, status → EXECUTED |
| 12 | Execute defeated proposal | getDecryptResultSafe returns 0, status → DEFEATED |
| 13 | Vote weight matches balance | Voter with higher balance has more influence on outcome |
| 14 | Side-channel resistance | Yes and no votes cost same gas (FHE.select pattern) |
| 15 | Set voting period | Only owner, applies to future proposals |
| 16 | Set quorum | Only owner, validated bounds |

### Integration Tests

| # | Test | Flow |
|---|---|---|
| 1 | Full protection lifecycle | Create protection → deposit reserve → trigger → batch payout → complete |
| 2 | Governance → protection trigger | Create proposal → vote (majority yes) → tally → execute → payout triggered |
| 3 | Governance defeated | Create proposal → vote (majority no) → tally → defeated, no trigger |
| 4 | End-to-end with MuHavenToken | Mint tokens → create protection → governance vote using token balances → payout |

---

## 9. New Files Summary

| File | Type | Priority |
|---|---|---|
| `contracts/interfaces/IDefaultProtection.sol` | Interface | P0 |
| `contracts/interfaces/IEncryptedGovernance.sol` | Interface | P0 |
| `contracts/DefaultProtection.sol` | Implementation | P0 |
| `contracts/EncryptedGovernance.sol` | Implementation | P0 |
| `contracts/KYCAttestationRegistry.sol` | Stub | P1 |
| `contracts/MuHavenKYCVerifier.sol` | Stub | P1 |
| `test/DefaultProtection.test.ts` | Tests | P0 |
| `test/EncryptedGovernance.test.ts` | Tests | P0 |
| `contracts/MuHavenToken.sol` | Modification | P0 |
| `contracts/interfaces/IMuHavenToken.sol` | Modification | P0 |

---

*Designed for MuHaven Wave 3. Compatible with cofhe-contracts v0.1.3, @cofhe/sdk v0.4.0, Solidity ^0.8.28.*
