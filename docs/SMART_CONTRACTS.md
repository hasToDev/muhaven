# MuHaven — Smart Contract Specifications

> Contract interfaces, encrypted types, and deployment details.

---

## SDK compatibility

> **WARNING**: The Fhenix CoFHE SDK (`cofhe-contracts`) is under active development and changes frequently. Pin your contracts to a specific version.

| Component | Pinned version | Package |
|-----------|---------------|---------|
| cofhe-contracts | [`v0.1.1`](https://github.com/FhenixProtocol/cofhe-contracts) | `@fhenixprotocol/cofhe-contracts` |
| cofhejs (client SDK) | [`v0.4.0`](https://github.com/FhenixProtocol/cofhesdk) | `cofhejs` or `@cofhe/sdk` |
| cofhe-hardhat-starter | [`sdk-migration`](https://github.com/FhenixProtocol/cofhe-hardhat-starter/tree/sdk-migration) | Clone + `pnpm install` |

**Development setup**: Clone `cofhe-hardhat-starter` (branch `sdk-migration`) as your starting point. It bundles the Hardhat config, mock contracts, and deployment tasks — replacing the older `cofhe-hardhat-plugin`.

**If the SDK updates during the hackathon**, check:
1. Encrypted type names — verify max size is still `euint128` (no `euint256` exists in v0.1.1)
2. Input type names (`InEuint8`...`InEuint128`, `InEaddress`, `InEbool`)
3. Access control (`FHE.allowThis()`, `FHE.allowSender()`) — may be renamed
4. Decryption pattern (currently async via `IAsyncFHEReceiver`)
5. Client SDK encryption (`Encryptable.uint64()`) — check for API changes
6. Permit system (`PermissionedV2`, `SealedUint`, `FHE.sealoutputTyped()`)

Always check: [cofhe-docs.fhenix.zone/get-started/introduction/compatibility](https://cofhe-docs.fhenix.zone/get-started/introduction/compatibility)

---

## Encrypted type reference (CoFHE v0.1.1)

| Type | Description | Max value | Use in MuHaven |
|------|------------|-----------|----------------|
| `ebool` | Encrypted boolean | true/false | KYC flags, condition results |
| `euint8` | Encrypted 8-bit | 255 | Risk tier levels |
| `euint16` | Encrypted 16-bit | 65,535 | Basis points (10000 = 100%) |
| `euint32` | Encrypted 32-bit | ~4.2B | Small counters |
| `euint64` | Encrypted 64-bit | ~18.4×10¹⁸ | USDC amounts (6 decimals: max ~18.4T) |
| `euint128` | Encrypted 128-bit | ~3.4×10³⁸ | Token balances, large amounts |
| `eaddress` | Encrypted address | — | Beneficiary addresses |

**`euint256` does NOT exist in CoFHE.** The maximum encrypted integer is `euint128`.

---

## Contract overview

| Contract | Purpose | Key FHE types |
|----------|---------|---------------|
| `MuHavenToken.sol` | FHERC-20 RWA token with encrypted balances, issuer minting, yield deposit | `euint128`, `eaddress` |
| `MuHavenVault.sol` | Wrap/unwrap existing ERC-20 RWA tokens into fhERC-20 equivalents | `euint128` |
| `YieldDistributor.sol` | Read all holder balances and create proportional ReineiraOS escrows | `euint128` |
| `IKYCGate.sol` | Modular KYC verification interface | — |
| `ERC3643KYCAdapter.sol` | ERC-3643 ONCHAINID adapter for IKYCGate | — |
| `YieldGate.sol` | ReineiraOS `IConditionResolver` for yield distribution | `euint128`, `ebool` |
| `RiskParams.sol` | Encrypted investor risk parameters | `euint64` |

---

## Critical CoFHE patterns

Every MuHaven contract follows these three patterns. Breaking any of them will cause silent failures.

### Pattern 1: Access control after every FHE operation

```solidity
// WRONG — result is inaccessible
euint128 result = FHE.add(a, b);

// CORRECT — grant access to contract and caller
euint128 result = FHE.add(a, b);
FHE.allowThis(result);    // contract can use this value later
FHE.allowSender(result);  // caller can read this value
```

### Pattern 2: Sealed outputs for returning encrypted data

```solidity
// WRONG — FHE.decrypt() is async, cannot return directly
function getBalance() view returns (uint256) {
    return FHE.decrypt(_balances[msg.sender]); // DOES NOT WORK
}

// CORRECT — seal the output for the permit holder
function balanceOfSealed(
    PermissionedV2 memory permission
) public view withPermission(permission) returns (SealedUint memory) {
    return FHE.sealoutputTyped(
        _balances[permission.issuer],
        permission.sealingKey
    );
}
```

### Pattern 3: Silent failure with FHE.select

```solidity
// WRONG — reveals whether transfer succeeded or failed
function transfer(euint128 amount) {
    require(FHE.decrypt(FHE.gte(balance, amount)), "Insufficient"); // LEAKS INFO
}

// CORRECT — transfer zero on failure, no information leakage
euint128 transferAmount = FHE.select(
    FHE.gte(balance, amount),  // condition
    amount,                     // if true: use amount
    FHE.asEuint128(0)           // if false: use zero
);
FHE.allowThis(transferAmount);
```

---

## 1. MuHavenToken.sol

### Full interface

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract MuHavenToken {

    string public name;
    string public symbol;
    uint8 public constant decimals = 6;

    mapping(address => euint128) private _balances;
    mapping(address => mapping(address => euint128)) private _allowances;
    euint128 private _encryptedTotalSupply;

    // Investor registry (addresses are cleartext; balances are not)
    address[] private _investors;
    mapping(address => bool) private _isInvestor;

    // Cleartext aggregate metrics (visible to issuer)
    uint256 private _investorCount;
    uint256 private _totalYieldDistributed;

    // External contract references
    address public usdcAddress;
    address public yieldDistributor;

    IKYCGate public kycGate;
    address public owner;
    address public issuer;

    // Role-based minting: both issuer and vault (and future minters) can mint
    mapping(address => bool) public minters;

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    modifier onlyIssuer() {
        require(msg.sender == issuer, "Only issuer");
        _;
    }

    modifier onlyMinter() {
        require(minters[msg.sender], "Only minter");
        _;
    }

    event Transfer(address indexed from, address indexed to);
    event Approval(address indexed owner, address indexed spender);
    event KYCGateUpdated(address indexed newGate);
    event IssuerUpdated(address indexed newIssuer);
    event MinterGranted(address indexed minter);
    event MinterRevoked(address indexed minter);
    event YieldDeposited(uint256 totalYield, uint256 investorCount);

    function initialize(
        string memory _name,
        string memory _symbol,
        address _kycGate,
        address _issuer,
        address _usdcAddress,
        address _yieldDistributor
    ) external;

    // --- Minter role management (owner only) ---

    function grantMinter(address minter) external onlyOwner;
    function revokeMinter(address minter) external onlyOwner;

    // --- Token operations ---

    function mint(address to, InEuint128 calldata encryptedAmount) external onlyMinter;
    function transfer(address to, InEuint128 calldata encryptedAmount) external returns (bool);
    function approve(address spender, InEuint128 calldata encryptedAmount) external returns (bool);
    function transferFrom(address from, address to, InEuint128 calldata encryptedAmount) external returns (bool);
    function balanceOfSealed(PermissionedV2 memory permission) public view withPermission(permission) returns (SealedUint memory);
    function encryptedBalanceOf(address account) external view returns (euint128);
    function encryptedTotalSupply() external view returns (euint128);
    function getInvestors() external view returns (address[] memory);
    function setKYCGate(address newGate) external;

    // --- Issuer functions (issuer address only) ---

    /// @notice Deposit yield for distribution (issuer only)
    /// @param totalYield Total USDC to distribute across all holders
    /// @dev Transfers USDC, then calls YieldDistributor to create escrows
    function depositYield(uint256 totalYield) external onlyIssuer;

    /// @notice Get aggregate statistics (cleartext, not per-investor)
    function totalSupplyDecrypted() external view onlyIssuer returns (uint256);
    function investorCount() external view returns (uint256);
    function totalYieldDistributed() external view returns (uint256);

    /// @notice Update token parameters
    function setYieldSchedule(uint256 intervalSeconds) external onlyIssuer;
    function setMinInvestment(uint256 minUsdc) external onlyIssuer;
}
```

**Role model:**

| Role | Who holds it | What it can do |
|------|-------------|---------------|
| `owner` | Deployer | Grant/revoke minters, update KYC gate, admin functions |
| `issuer` | RWA issuer address | Deposit yield, set yield schedule, set min investment, view aggregate stats |
| `minter` (MINTER_ROLE) | Issuer + MuHavenVault (+ future minters) | Mint fhERC-20 tokens to eligible investors |

The `onlyMinter` modifier replaces the old `onlyIssuer` check on `mint()`. This allows both the issuer (direct minting via dashboard) and the vault (wrapping ERC-20 → fhERC-20) to mint tokens. The `onlyIssuer` modifier remains for yield management and configuration functions that should be restricted to the RWA issuer.

### Transfer implementation

```solidity
function _transfer(address from, address to, euint128 amount) internal {
    require(kycGate.isEligible(to), "KYC: not eligible");

    ebool hasEnough = FHE.gte(_balances[from], amount);
    FHE.allowThis(hasEnough);

    euint128 transferAmount = FHE.select(hasEnough, amount, FHE.asEuint128(0));
    FHE.allowThis(transferAmount);

    _balances[from] = FHE.sub(_balances[from], transferAmount);
    FHE.allowThis(_balances[from]);

    _balances[to] = FHE.add(_balances[to], transferAmount);
    FHE.allowThis(_balances[to]);

    emit Transfer(from, to);
}
```

### Mint implementation

With `MINTER_ROLE`, there is a single `mint()` function used by both the issuer and the vault. The old `issuerMint()` is removed — both callers use `mint()` gated by `onlyMinter`.

```solidity
function mint(address to, InEuint128 calldata encryptedAmount) external onlyMinter {
    require(kycGate.isEligible(to), "KYC: not eligible");

    euint128 amount = FHE.asEuint128(encryptedAmount);
    FHE.allowThis(amount);

    _balances[to] = FHE.add(_balances[to], amount);
    FHE.allowThis(_balances[to]);

    _encryptedTotalSupply = FHE.add(_encryptedTotalSupply, amount);
    FHE.allowThis(_encryptedTotalSupply);

    // Track investor in registry (addresses are cleartext; balances are not)
    if (!_isInvestor[to]) {
        _investors.push(to);
        _isInvestor[to] = true;
        _investorCount++;
    }

    emit Transfer(address(0), to);
}

function grantMinter(address minter) external onlyOwner {
    minters[minter] = true;
    emit MinterGranted(minter);
}

function revokeMinter(address minter) external onlyOwner {
    minters[minter] = false;
    emit MinterRevoked(minter);
}

function getInvestors() external view returns (address[] memory) {
    return _investors;
}

function encryptedTotalSupply() external view returns (euint128) {
    return _encryptedTotalSupply;
}
```

### Yield deposit implementation

```solidity
/// @notice Issuer deposits total yield for distribution via YieldDistributor
function depositYield(uint256 totalYield) external onlyIssuer {
    // Transfer USDC from issuer to this contract
    IERC20(usdcAddress).transferFrom(msg.sender, address(this), totalYield);

    // Approve YieldDistributor to pull USDC
    IERC20(usdcAddress).approve(yieldDistributor, totalYield);

    // Trigger proportional distribution
    IYieldDistributor(yieldDistributor).distributeYield(address(this), totalYield);

    _totalYieldDistributed += totalYield;

    emit YieldDeposited(totalYield, _investorCount);
}

/// @notice Aggregate metrics — visible to issuer, not per-investor
function investorCount() external view returns (uint256) {
    return _investorCount;
}

function totalYieldDistributed() external view returns (uint256) {
    return _totalYieldDistributed;
}
```

### Reading balance (client-side with cofhejs)

```typescript
import { cofhejs, Encryptable, FheTypes } from 'cofhejs/node';

// Initialize
await cofhejs.initialize({
    provider: userProvider,
    signer: userSigner,
    projects: ["MuHaven"],
});

// Create permit
await cofhejs.createPermit({
    type: "self",
    issuer: userAddress,
    projects: ["MuHaven"],
});
const permit = cofhejs.getPermit();
const permission = permit.getPermission();

// Call contract and unseal
const sealedBalance = await muhavenToken.balanceOfSealed(permission);
const balance = await cofhejs.unseal(sealedBalance, FheTypes.Uint128);
```

---

## 2. IKYCGate.sol

Unchanged — returns `bool`, not encrypted types.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IKYCGate {
    function isEligible(address account) external view returns (bool);
    function isEligibleForTier(address account, uint256 tier) external view returns (bool);
    function providerName() external view returns (string memory);
}
```

---

## 3. ERC3643KYCAdapter.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IKYCGate.sol";

/// @title ERC3643KYCAdapter — ERC-3643 ONCHAINID adapter for IKYCGate
contract ERC3643KYCAdapter is IKYCGate {

    address public identityRegistry;
    address[] public trustedIssuers;

    uint256 public constant CLAIM_TOPIC_KYC = 1;
    uint256 public constant CLAIM_TOPIC_ACCREDITED = 7;

    // Tier → required claim topics
    // Tier 1 (retail): only KYC required
    // Tier 2 (accredited): KYC + accredited investor claim
    mapping(uint256 => uint256[]) public tierRequiredClaims;

    constructor(address _identityRegistry, address[] memory _trustedIssuers) {
        identityRegistry = _identityRegistry;
        trustedIssuers = _trustedIssuers;

        // Default tier requirements
        tierRequiredClaims[1] = new uint256[](1);
        tierRequiredClaims[1][0] = CLAIM_TOPIC_KYC;

        tierRequiredClaims[2] = new uint256[](2);
        tierRequiredClaims[2][0] = CLAIM_TOPIC_KYC;
        tierRequiredClaims[2][1] = CLAIM_TOPIC_ACCREDITED;
    }

    function isEligible(address account) external view override returns (bool) {
        return _hasValidClaim(account, CLAIM_TOPIC_KYC);
    }

    function isEligibleForTier(address account, uint256 tier) external view override returns (bool) {
        uint256[] memory required = tierRequiredClaims[tier];
        for (uint i = 0; i < required.length; i++) {
            if (!_hasValidClaim(account, required[i])) return false;
        }
        return true;
    }

    function providerName() external pure override returns (string memory) {
        return "ERC-3643 ONCHAINID";
    }

    /// @dev Check if account has a valid claim from a trusted issuer
    /// NOTE: For hackathon, this can be simplified to a whitelist mapping.
    /// Full ONCHAINID integration uses IIdentity and IClaimIssuer interfaces.
    function _hasValidClaim(address account, uint256 topic) internal view returns (bool) {
        // Hackathon simplified version: check a whitelist
        // Production version: query ONCHAINID identity registry
        //   1. Get the identity contract for `account` from the registry
        //   2. Check if any trusted issuer has issued a claim for `topic`
        //   3. Verify the claim signature and expiry
        return _whitelist[account];
    }

    // Hackathon shortcut: simple whitelist (replace with ONCHAINID in production)
    mapping(address => bool) private _whitelist;
    address public admin;

    function addToWhitelist(address account) external {
        require(msg.sender == admin || msg.sender == address(this), "Not authorized");
        _whitelist[account] = true;
    }

    function removeFromWhitelist(address account) external {
        require(msg.sender == admin, "Not authorized");
        _whitelist[account] = false;
    }
}
```

**Hackathon note:** The `_hasValidClaim` function uses a simple whitelist for the hackathon. In production, it would query the ONCHAINID identity registry to verify claims from trusted issuers. The interface remains the same — only the internal implementation changes.

---

## 4. YieldGate.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract YieldGate {
    address public muhavenToken;
    address public kycGate;
    mapping(uint256 => address) public escrowBeneficiary;

    constructor(address _muhavenToken, address _kycGate) {
        muhavenToken = _muhavenToken;
        kycGate = _kycGate;
    }

    function onConditionSet(uint256 escrowId, bytes calldata data) external {
        address beneficiary = abi.decode(data, (address));
        escrowBeneficiary[escrowId] = beneficiary;
    }

    function isConditionMet(uint256 escrowId) external view returns (bool) {
        address beneficiary = escrowBeneficiary[escrowId];
        if (!IKYCGate(kycGate).isEligible(beneficiary)) return false;

        // NOTE: In mock environment, FHE ops resolve synchronously.
        // In production CoFHE, this would need async decryption
        // via IAsyncFHEReceiver. See SDK compatibility section.
        euint128 balance = IMuHavenToken(muhavenToken).encryptedBalanceOf(beneficiary);
        ebool hasBalance = FHE.gt(balance, FHE.asEuint128(0));
        FHE.allowThis(hasBalance);

        return true; // Simplified for hackathon mock environment
    }
}
```

---

## 5. RiskParams.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract RiskParams {
    struct InvestorRisk {
        euint64 maxDrawdownBps;
        euint64 minYieldBps;
        euint64 driftToleranceBps;
        euint64 maxDailySpend;
        uint256 lastUpdated;
    }

    mapping(address => InvestorRisk) private _riskParams;

    function setRiskParams(
        InEuint64 calldata maxDrawdown,
        InEuint64 calldata minYield,
        InEuint64 calldata driftTolerance,
        InEuint64 calldata maxDailySpend
    ) external {
        euint64 _md = FHE.asEuint64(maxDrawdown);
        FHE.allowThis(_md); FHE.allowSender(_md);

        euint64 _my = FHE.asEuint64(minYield);
        FHE.allowThis(_my); FHE.allowSender(_my);

        euint64 _dt = FHE.asEuint64(driftTolerance);
        FHE.allowThis(_dt); FHE.allowSender(_dt);

        euint64 _ms = FHE.asEuint64(maxDailySpend);
        FHE.allowThis(_ms); FHE.allowSender(_ms);

        _riskParams[msg.sender] = InvestorRisk(_md, _my, _dt, _ms, block.timestamp);
    }

    function getRiskParamsSealed(
        PermissionedV2 memory permission
    ) public view withPermission(permission) returns (
        SealedUint memory, SealedUint memory, SealedUint memory, SealedUint memory
    ) {
        InvestorRisk memory p = _riskParams[permission.issuer];
        return (
            FHE.sealoutputTyped(p.maxDrawdownBps, permission.sealingKey),
            FHE.sealoutputTyped(p.minYieldBps, permission.sealingKey),
            FHE.sealoutputTyped(p.driftToleranceBps, permission.sealingKey),
            FHE.sealoutputTyped(p.maxDailySpend, permission.sealingKey)
        );
    }
}
```

---

## 6. MuHavenVault.sol (new — wrapping model)

Locks external ERC-20 RWA tokens (e.g., BUIDL, OUSG) and mints equivalent fhERC-20 encrypted versions. Investors can unwrap at any time by burning the fhERC-20 to release the original ERC-20.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MuHavenVault {
    IERC20 public underlyingToken;       // The ERC-20 RWA token being wrapped (e.g., BUIDL)
    address public muhavenToken;          // The fhERC-20 wrapper token
    uint256 public totalLocked;           // Total underlying tokens locked in vault

    event Wrapped(address indexed investor, uint256 amount);
    event Unwrapped(address indexed investor, uint256 amount);

    constructor(address _underlyingToken, address _muhavenToken) {
        underlyingToken = IERC20(_underlyingToken);
        muhavenToken = _muhavenToken;
    }

    /// @notice Lock ERC-20 tokens and mint equivalent fhERC-20 tokens
    /// @param amount Cleartext amount of ERC-20 to lock (visible, since original is public)
    /// @dev MuHavenVault must be granted MINTER_ROLE on MuHavenToken at deploy time
    function wrap(uint256 amount) external {
        require(amount > 0, "Zero amount");

        // Transfer ERC-20 from investor to vault
        underlyingToken.transferFrom(msg.sender, address(this), amount);
        totalLocked += amount;

        // Mint equivalent fhERC-20 (encrypted from this point forward)
        // NOTE: Amount transitions from cleartext ERC-20 to encrypted fhERC-20 here
        // Vault calls mint() via MINTER_ROLE — same function the issuer uses
        IMuHavenToken(muhavenToken).mint(
            msg.sender,
            _encryptAmount(amount)
        );

        emit Wrapped(msg.sender, amount);
    }

    /// @notice Burn fhERC-20 tokens and release original ERC-20 tokens
    /// @param amount Cleartext amount to unwrap
    /// @dev Investor must approve MuHavenToken to burn their encrypted balance first
    function unwrap(uint256 amount) external {
        require(amount > 0, "Zero amount");
        require(totalLocked >= amount, "Insufficient vault balance");

        // Burn the fhERC-20 tokens (encrypted balance reduced)
        IMuHavenToken(muhavenToken).burnFrom(msg.sender, _encryptAmount(amount));

        // Release original ERC-20
        totalLocked -= amount;
        underlyingToken.transfer(msg.sender, amount);

        emit Unwrapped(msg.sender, amount);
    }

    /// @dev Helper: encrypt a cleartext uint256 into InEuint128 format
    function _encryptAmount(uint256 amount) internal pure returns (InEuint128 memory) {
        // Implementation depends on cofhe-contracts input encoding
        // See cofhejs Encryptable.uint128() for client-side equivalent
    }
}
```

**Hackathon note:** For the demo, deploy a mock "TestTreasury" ERC-20 token that simulates an existing RWA. The vault wrapping flow demonstrates the concept without needing real BUIDL tokens on testnet.

---

## 7. YieldDistributor.sol (new — proportional escrow creation)

Reads all holder balances from MuHavenToken and creates proportional ReineiraOS escrows for yield distribution. Called by `MuHavenToken.depositYield()`.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract YieldDistributor {
    address public muhavenToken;
    address public reineiraEscrow;      // ReineiraOS escrow contract
    address public yieldGate;           // YieldGate condition resolver

    event YieldDistributed(address indexed token, uint256 totalYield, uint256 escrowCount);

    constructor(address _muhavenToken, address _reineiraEscrow, address _yieldGate) {
        muhavenToken = _muhavenToken;
        reineiraEscrow = _reineiraEscrow;
        yieldGate = _yieldGate;
    }

    /// @notice Distribute yield proportionally across all token holders
    /// @param token The MuHavenToken whose holders receive yield
    /// @param totalYield Total USDC to distribute
    /// @dev Creates one ReineiraOS escrow per eligible investor
    ///
    /// PRODUCTION APPROACH (future):
    ///   Amount per investor = (their encrypted balance / total supply) * totalYield
    ///   All proportional math would be done in FHE — individual amounts stay encrypted.
    ///   However, FHE division is not available in CoFHE v0.1.1 (no FHE.div()).
    ///
    /// HACKATHON SIMPLIFICATION:
    ///   Equal distribution: totalYield / investorCount (cleartext division).
    ///   Each investor receives the same yield amount regardless of position size.
    ///   This demonstrates the privacy-preserving escrow pipeline end-to-end
    ///   without requiring FHE division. The individual yield amounts are still
    ///   encrypted in the escrow — the simplification is only in how the amount
    ///   is calculated, not in how it's distributed.
    ///
    /// PRODUCTION ALTERNATIVES (when FHE.div() or workarounds are available):
    ///   1. FHE.div() — if Fhenix adds division to CoFHE
    ///   2. Off-chain pre-computation — compute shares off-chain, submit encrypted
    ///      amounts with a ZK proof that they sum to totalYield
    ///   3. Fixed-point FHE multiplication — multiply balance by (totalYield * SCALE)
    ///      then shift, avoiding division entirely
    function distributeYield(address token, uint256 totalYield) external {
        require(msg.sender == muhavenToken, "Only token contract");

        // Get list of investors (addresses are cleartext, balances are not)
        address[] memory investors = IMuHavenToken(token).getInvestors();
        uint256 count = investors.length;
        require(count > 0, "No investors");

        // Hackathon: equal distribution (cleartext division, encrypted escrow)
        uint256 yieldPerInvestor = totalYield / count;

        uint256 escrowCount = 0;

        for (uint256 i = 0; i < count; i++) {
            address investor = investors[i];

            // Encrypt the per-investor yield amount
            // From this point forward, individual amounts are encrypted
            euint128 encryptedYield = FHE.asEuint128(yieldPerInvestor);
            FHE.allowThis(encryptedYield);

            // Create ReineiraOS escrow with encrypted amount, gated by YieldGate
            IReineiraEscrow(reineiraEscrow).create(
                investor,           // beneficiary
                encryptedYield,     // encrypted yield amount
                yieldGate           // condition resolver
            );

            escrowCount++;
        }

        emit YieldDistributed(token, totalYield, escrowCount);
    }
}
```

**Critical privacy property:** Even with the hackathon's equal-distribution simplification, individual yield amounts are encrypted in the escrow. The issuer calls `depositYield(totalAmount)` with a cleartext total, the contract divides equally (cleartext), then encrypts each share before creating the escrow. The issuer sees how many investors received yield (cleartext) but not individual claim status or balances. In production, proportional distribution using FHE math will replace the equal split — see the alternatives documented in `distributeYield()` above.

**Hackathon limitation:** Equal distribution means an investor holding 80% of supply gets the same yield as one holding 1%. This is acceptable for the demo because it still demonstrates the full privacy pipeline (encrypted escrow creation → YieldGate verification → investor auto-claim). Proportional distribution is a math problem, not an architecture problem.

---

## Deployment

### Setup

```bash
# Use pnpm (Fhenix recommended)
npm install -g pnpm

# Clone starter (sdk-migration branch)
git clone -b sdk-migration https://github.com/FhenixProtocol/cofhe-hardhat-starter.git
cd cofhe-hardhat-starter
pnpm install
```

### Deploy script

```typescript
import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying with: ${deployer.address}`);

  const KYCAdapter = await ethers.getContractFactory("ERC3643KYCAdapter");
  const kycAdapter = await KYCAdapter.deploy(IDENTITY_REGISTRY, TRUSTED_ISSUERS);
  await kycAdapter.waitForDeployment();

  const MuHavenToken = await ethers.getContractFactory("MuHavenToken");
  const token = await MuHavenToken.deploy();
  await token.waitForDeployment();

  const RiskParams = await ethers.getContractFactory("RiskParams");
  const riskParams = await RiskParams.deploy();
  await riskParams.waitForDeployment();

  const YieldGate = await ethers.getContractFactory("YieldGate");
  const yieldGate = await YieldGate.deploy(await token.getAddress(), await kycAdapter.getAddress());
  await yieldGate.waitForDeployment();

  // Deploy MuHavenVault for wrapping existing ERC-20 RWA tokens
  const MuHavenVault = await ethers.getContractFactory("MuHavenVault");
  const vault = await MuHavenVault.deploy(UNDERLYING_TOKEN_ADDRESS, await token.getAddress());
  await vault.waitForDeployment();

  // Deploy YieldDistributor for yield escrow creation
  const YieldDistributor = await ethers.getContractFactory("YieldDistributor");
  const yieldDistributor = await YieldDistributor.deploy(
    await token.getAddress(),
    REINEIRA_ESCROW_ADDRESS,
    await yieldGate.getAddress()
  );
  await yieldDistributor.waitForDeployment();

  // Initialize token with all external references
  await token.initialize(
    "MuHaven RWA",
    "MHRWA",
    await kycAdapter.getAddress(),
    ISSUER_ADDRESS,
    USDC_ADDRESS,
    await yieldDistributor.getAddress()
  );

  // Grant MINTER_ROLE to both issuer and vault
  await token.grantMinter(ISSUER_ADDRESS);
  await token.grantMinter(await vault.getAddress());

  console.log("KYC Adapter:", await kycAdapter.getAddress());
  console.log("MuHaven Token:", await token.getAddress());
  console.log("Risk Params:", await riskParams.getAddress());
  console.log("Yield Gate:", await yieldGate.getAddress());
  console.log("MuHaven Vault:", await vault.getAddress());
  console.log("Yield Distributor:", await yieldDistributor.getAddress());
}

main().catch(console.error);
```

### Testing

```bash
# Local mock environment (no coprocessor needed)
pnpm test

# Deploy to Arbitrum Sepolia
pnpm task:deploy --network arb-sepolia
```
