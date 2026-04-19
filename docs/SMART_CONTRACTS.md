# MuHaven — Smart Contract Specifications

> Contract interfaces, encrypted types, and deployment details.

---

## SDK compatibility

> **WARNING**: The Fhenix CoFHE SDK (`cofhe-contracts`) is under active development and changes frequently. Pin your contracts to a specific version.

| Component | Pinned version                                                                                | Package |
|-----------|-----------------------------------------------------------------------------------------------|---------|
| cofhe-contracts | [`v0.1.3`](https://github.com/FhenixProtocol/cofhe-contracts)                                 | `@fhenixprotocol/cofhe-contracts` |
| @cofhe/sdk (client SDK) | [`v0.4.0`](https://github.com/FhenixProtocol/cofhesdk)                                    | `@cofhe/sdk`, `@cofhe/hardhat-plugin`, `@cofhe/mock-contracts` |
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

> **`euint64` underlying type breaking change (v0.1.0):** cofhe-contracts v0.1.0 changed `type euint64` from wrapping `uint256` to wrapping `bytes32` (same for all encrypted types). This changes ABI function selectors for any function with `euint64` parameters — e.g., `confidentialTransferFrom(address,address,uint256)` became `confidentialTransferFrom(address,address,bytes32)`. The 32-byte handle values are identical; only the 4-byte selector differs.
>
> **Impact:** If you call an FHERC20 contract deployed with pre-v0.1.0 cofhe-contracts from code compiled with v0.1.0+, the call will revert with empty data (`0x`) because no matching function exists. MuHaven encountered this with the deployed ConfidentialUSDC on Arb Sepolia. Fix: use a low-level call with the correct selector, or deploy your own FHERC20. See `development/DEV_WAVE_3/PUSDC_TRANSFER_ISSUE.md` for the full diagnosis and resolution.

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
| `InvestorRegistry.sol` | Paginated registry of all MuHavenToken holders, used by `YieldDistributor` for batch iteration | — |
| `YieldDistributor.sol` | Proportional yield distribution state machine — drives `MuHavenEscrow` creation + funding | `euint64`, `euint128` |
| `MuHavenEscrow.sol` | Two-phase confidential escrow for per-investor yield settlement (replaces ReineiraOS `ConfidentialEscrow` for MuHaven flows) | `eaddress`, `euint64`, `ebool` |
| `IKYCGate.sol` | Modular KYC verification interface | — |
| `ERC3643KYCAdapter.sol` | ERC-3643 ONCHAINID adapter for IKYCGate | — |
| `YieldGate.sol` | ReineiraOS-style `IConditionResolver` — verifies investor KYC + token balance eligibility for yield release | `euint128`, `ebool` |
| `RiskParams.sol` | Encrypted investor risk parameters | `euint64` |

---

## Critical CoFHE patterns

Every MuHaven contract follows these patterns. Breaking any of them will cause silent failures or information leaks.

### Pattern 1: Access control after every FHE operation

Every new handle returned from an `FHE.*` call — `add`, `sub`, `select`, `asEuint*`, `asEaddress`, etc. — must be authorized before the transaction ends. Otherwise, the handle is inaccessible from any subsequent call.

```solidity
// WRONG — result is inaccessible
euint128 result = FHE.add(a, b);

// CORRECT — grant access to contract and value owner
euint128 result = FHE.add(a, b);
FHE.allowThis(result);              // contract can reuse the handle later
FHE.allow(result, ownerAddress);    // ownerAddress can decryptForView via permit
```

Use `FHE.allowSender(h)` as a shortcut when the value owner is `msg.sender`. Use `FHE.allowPublic(h)` only for truly public aggregates (e.g., optional public total supply) — the call is irreversible.

### Pattern 2: Permit-based client decryption (UI)

`sealOutput` / `sealoutputTyped` are **not available in cofhe-contracts v0.1.3**. Some older code fragments in this document still reference that pattern — the deployed contracts do not. Client UI reads use permit-based `decryptForView` instead:

```solidity
// Contract: grant the value owner permit access to the current ciphertext handle
function mint(address to, InEuint128 calldata encryptedAmount) external onlyMinter {
    euint128 amount = FHE.asEuint128(encryptedAmount);
    _balances[to] = FHE.add(_balances[to], amount);
    FHE.allowThis(_balances[to]);
    FHE.allow(_balances[to], to);        // critical — permit for new handle
}
```

```typescript
// Client: decrypt the ciphertext using the user's permit — no task, no polling
const plaintext = await cofheClient
  .decryptForView(ctHash)
  .withPermit()
  .execute();
```

Because every `FHE.add` / `FHE.sub` / `FHE.select` produces a new handle, `FHE.allow` must be re-granted on the new handle after every mutation.

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

Side-channel property: a valid and a silently-nullified operation take identical gas, so gas observers cannot distinguish success from failure. `MuHavenToken`, `YieldDistributor`, and `MuHavenEscrow` all apply this pattern consistently.

### Pattern 4: Guarding against uninitialized handles

FHE operations on the zero handle (e.g., a `mapping`-default `euint128`) revert. Contracts that may read storage before first write must guard:

```solidity
import "@fhenixprotocol/cofhe-contracts/Common.sol";

if (Common.isInitialized(_balances[to])) {
    _balances[to] = FHE.add(_balances[to], amount);
} else {
    _balances[to] = amount;
}
FHE.allowThis(_balances[to]);
FHE.allow(_balances[to], to);
```

`MuHavenToken`, `YieldGate`, and `MuHavenEscrow.fundFrom` all use this guard.

### Pattern 5: On-chain async decrypt (only when plaintext must reach the EVM)

When contract logic genuinely needs a plaintext — not a UI read — use the async decrypt flow:

```solidity
ITaskManager(taskManager).createDecryptTask(handle);
// ... coprocessor delay (~seconds on mainnet; simulate with `time.increase(11)` in tests) ...
(uint256 value, bool ready) = FHE.getDecryptResultSafe(handle);
require(ready, "Decrypt not ready");
```

Prefer pushing a plaintext result on-chain via `decryptForTx` + `publishDecryptResult` rather than polling `createDecryptTask` where possible. Never return raw `euint` handles from external functions to untrusted callers.

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

### Reading balance (client-side with @cofhe/sdk)

MuHavenToken uses the **permit-based client decryption** pattern: every balance mutation grants `FHE.allow(newHandle, ownerAddress)`, and the client decrypts the current ciphertext handle through its permit — no on-chain task, no polling.

```typescript
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { createCofheClient, createCofheConfig, Encryptable, FheTypes } from '@cofhe/sdk/node';
import { arbSepolia } from '@cofhe/sdk/chains';

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(process.env.RPC_URL) });
const walletClient = createWalletClient({ account, chain: arbitrumSepolia, transport: http(process.env.RPC_URL) });

const cofheClient = createCofheClient(createCofheConfig({ supportedChains: [arbSepolia] }));
await cofheClient.connect(publicClient, walletClient);
await cofheClient.permits.createSelf({ issuer: account.address });

// Read: fetch the current ciphertext handle, then decrypt via permit
const ctHash = await muhavenToken.read.encryptedBalanceOf([account.address]);
const balance = await cofheClient
    .decryptForView(ctHash)
    .forType(FheTypes.Uint128)
    .withPermit()
    .execute();

// Write: encrypt the input, submit the transfer
const [encAmount] = await cofheClient
    .encryptInputs([Encryptable.uint128(1000n * 10n ** 6n)])   // USDC has 6 decimals
    .execute();
await walletClient.writeContract({
    address: muhavenToken.address,
    abi: muhavenTokenAbi,
    functionName: 'transfer',
    args: [recipientAddress, encAmount],
});
```

`MuHavenToken` still exposes `requestBalanceDecrypt` / `getBalanceDecryptResult` helpers for backwards compatibility with earlier integrations, but new clients should use the permit-based `decryptForView` flow above. The `sealOutput` / `sealoutputTyped` pattern referenced in older drafts was removed in cofhe-contracts v0.1.3.

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

Implements `IConditionResolver` for `MuHavenEscrow`. The resolver returns an **encrypted** boolean (`ebool`) that MuHavenEscrow folds into its silent-failure AND chain. Cleartext booleans are checked (KYC + balance-initialized) and the combined result is trivially encrypted.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract YieldGate is IConditionResolver, ERC165 {
    IMuHavenToken public immutable muhavenToken;
    IKYCGate       public immutable kycGate;
    address public owner;
    address public authorizedEscrow;                     // only caller of onConditionSet
    mapping(uint256 => address) private _escrowBeneficiary;

    event ConditionSet(uint256 indexed escrowId);        // beneficiary NOT emitted
    event AuthorizedEscrowUpdated(address indexed newEscrow);
    event OwnershipTransferred(address indexed prev, address indexed next);

    function onConditionSet(uint256 escrowId, bytes calldata data) external {
        require(msg.sender == authorizedEscrow, "only escrow");
        require(_escrowBeneficiary[escrowId] == address(0), "already set");
        address beneficiary = abi.decode(data, (address));
        _escrowBeneficiary[escrowId] = beneficiary;
        emit ConditionSet(escrowId);
    }

    function canRedeem(uint256 escrowId) external returns (ebool allowed) {
        address beneficiary = _escrowBeneficiary[escrowId];
        require(beneficiary != address(0), "unknown escrow");

        bool kycOk = kycGate.isEligible(beneficiary);
        euint128 encBalance = muhavenToken.encryptedBalanceOf(beneficiary);
        bool hasBalance = Common.isInitialized(encBalance);                  // hackathon proxy

        allowed = FHE.asEbool(kycOk && hasBalance);
        FHE.allowThis(allowed);
        FHE.allow(allowed, msg.sender);                                      // MuHavenEscrow can fold
    }

    function setAuthorizedEscrow(address newEscrow) external onlyOwner;
    function transferOwnership(address newOwner) external onlyOwner;
    // supportsInterface(type(IConditionResolver).interfaceId)
}
```

**Privacy caveat:** `_escrowBeneficiary` stores plaintext beneficiaries because the KYC check is cleartext. The mapping is `private` with no public getter, but storage slots are readable via `eth_getStorageAt`. This is an acknowledged residual leak of the `eaddress`-owner privacy goal — fully closing it requires an FHE-based KYC gate. See [THREAT_MODEL.md](./THREAT_MODEL.md).

**Production upgrade path:** Replace the `Common.isInitialized` check with `FHE.gt(balance, FHE.asEuint128(0))` + async decrypt for a definitive balance-greater-than-zero verdict. The current proxy is sufficient because tokens are only minted to KYC-verified investors.

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

## 8. InvestorRegistry.sol

Paginated registry of MuHavenToken holders. Addresses are public (they're always visible in transfer calldata); balances are not. `YieldDistributor` iterates the registry in batches to drive `MuHavenEscrow.batchCreate`, and the SDK uses it to enumerate investors before encrypting them for escrow creation.

```solidity
contract InvestorRegistry {
    address public owner;
    address public tokenContract;  // MuHavenToken — only authorized caller

    address[] private _investors;
    mapping(address => bool) private _isInvestor;

    event InvestorAdded(address indexed investor);

    function initialize(address _owner, address _tokenContract) external;

    /// @dev Called by MuHavenToken on first mint() to a new address
    function addInvestor(address investor) external onlyTokenContract;

    function count() external view returns (uint256);
    function isInvestor(address account) external view returns (bool);
    function getInvestors(uint256 offset, uint256 limit)
        external view returns (address[] memory);
}
```

**Access control:** Only `tokenContract` (MuHavenToken) may call `addInvestor`. `getInvestors` is public.

**Pagination:** Callers pass `(offset, limit)`. The SDK's `fetchAllInvestors` utility calls in pages of 200 and concatenates.

---

## 9. MuHavenEscrow.sol

Two-phase confidential escrow for per-investor yield settlement. Replaces ReineiraOS's `ConfidentialEscrow` for MuHaven flows after the PUSDC selector-mismatch workaround made the upstream contract unusable (see `development/DEV_WAVE_3/PUSDC_TRANSFER_ISSUE.md`). Each escrow stores an encrypted beneficiary address, an encrypted running payout, and an encrypted redeemed flag.

**Deployed (Arb Sepolia):** proxy `0xb18ca2122b31Df9Aaef8226f6218Bd93B852F40A`.

### Storage

```solidity
struct Escrow {
    eaddress owner;        // ZK-validated investor address (encrypted)
    euint64  paidAmount;   // running sum of deposits (encrypted)
    ebool    isRedeemed;   // encrypted redemption flag
    address  resolver;     // plaintext IConditionResolver (YieldGate)
    bool     exists;       // plaintext existence flag
}

mapping(uint256 => Escrow) private _escrows;   // id => escrow (ids start at 1)
uint256 public escrowCount;
address public paymentToken;                   // PUSDC (IFHERC20)
address public contractOwner;
mapping(address => bool) public authorizedCallers;  // batchCreate / fundFrom gate
uint256[50] private __gap;                     // proxy upgrade gap
```

### Initializer

```solidity
function initialize(address _owner, address _paymentToken) external initializer;
```

`_paymentToken` may be zero at deploy — set later via `setPaymentToken`.

### Events

```solidity
event EscrowCreated(uint256 indexed escrowId, address indexed resolver);
event EscrowFunded(uint256 indexed escrowId);
event EscrowRedeemed(uint256 indexed escrowId);      // emitted unconditionally — see silent-fail note
event AuthorizedCallerUpdated(address indexed caller, bool authorized);
event PaymentTokenUpdated(address indexed newToken);
event OwnershipTransferred(address indexed previous, address indexed newOwner);
```

### Two-phase architecture

Privacy hinges on splitting the ZK-validation step (client) from handle storage (contract):

```
Client (SDK)                              Contract
────────────                              ────────
encryptInputs([addr1, addr2, ...])  ──→   one shared ZK proof
                                    ←──   InEaddress[] tuples

batchCreate(inputs, resolver, data) ──→   FHE.asEaddress(each)   // ZK verified
                                          FHE.allowThis(eaddress)
                                          resolver.onConditionSet(id, data)
                                          emit EscrowCreated(id, resolver)
                                    ←──   sequential IDs via event logs
```

The plaintext beneficiary is encoded into `resolverData` so `YieldGate.onConditionSet` can cache the escrow-id → investor mapping off-chain. Observers reading calldata can link `escrowId ↔ investor` at creation, but events and state emit only `escrowId` — passive log analysis cannot reconstruct the mapping from on-chain data alone.

### Core API

```solidity
/// @notice Create many escrows in one tx; IDs assigned sequentially.
function batchCreate(
    InEaddress[] calldata owners,
    address resolver,
    bytes[]   calldata resolverData
) external onlyAuthorized returns (uint256[] memory ids);

/// @notice Add encrypted PUSDC to an escrow. Multiple calls accumulate.
function fundFrom(uint256 id, euint64 amount) external onlyAuthorized;

/// @notice Investor-initiated claim. Silent-fail on wrong caller /
///         already-redeemed / resolver denial.
function redeem(uint256 id) external;

/// @notice Batch version. Skips non-existent IDs, aggregates payouts,
///         one PUSDC transfer if total non-zero.
function redeemMultiple(uint256[] calldata ids) external;

// View helpers
function exists(uint256 id) external view returns (bool);
function getOwner(uint256 id) external view returns (eaddress);
function getPaidAmount(uint256 id) external view returns (euint64);
function getIsRedeemed(uint256 id) external view returns (ebool);
function getResolver(uint256 id) external view returns (address);
function total() external view returns (uint256);

// Admin
function setAuthorizedCaller(address caller, bool authorized) external onlyContractOwner;
function setPaymentToken(address token) external onlyContractOwner;
function transferOwnership(address newOwner) external onlyContractOwner;
```

### Redemption internals — silent-fail in detail

```solidity
function _computePayout(uint256 id)
    internal
    returns (euint64 payout, ebool canRedeem)
{
    Escrow storage e = _escrows[id];
    if (!e.exists) revert EscrowDoesNotExist();

    // Trivially-encrypt the plaintext caller so we can compare to the encrypted owner
    eaddress callerEa = FHE.asEaddress(msg.sender);
    FHE.allowThis(callerEa);

    ebool ownerOk = FHE.eq(e.owner, callerEa);                              // (1) owner == msg.sender
    ebool notRedeemed = Common.isInitialized(e.isRedeemed)                 // (2) NOT isRedeemed
        ? FHE.not(e.isRedeemed)
        : FHE.asEbool(true);
    ebool resolverOk  = IConditionResolver(e.resolver).canRedeem(id);      // (3) resolver gate

    canRedeem = FHE.and(FHE.and(ownerOk, notRedeemed), resolverOk);
    FHE.allowThis(canRedeem);

    euint64 zero64 = FHE.asEuint64(uint256(0));
    euint64 funded = Common.isInitialized(e.paidAmount) ? e.paidAmount : zero64;
    payout = FHE.select(canRedeem, funded, zero64);
    FHE.allowThis(payout);
}

function _markRedeemed(uint256 id, ebool canRedeem) internal {
    Escrow storage e = _escrows[id];
    ebool prior = Common.isInitialized(e.isRedeemed) ? e.isRedeemed : FHE.asEbool(false);
    ebool trueE = FHE.asEbool(true);
    e.isRedeemed = FHE.select(canRedeem, trueE, prior);
    FHE.allowThis(e.isRedeemed);
}
```

All three conditions (owner match, not-already-redeemed, resolver-approves) are AND'd in FHE. `FHE.select` nullifies the payout to zero if any condition fails. `isRedeemed` only flips when the full AND is encrypted-true. A failed redemption costs the same gas as a successful one and emits the same event — observers cannot tell them apart on-chain.

### PUSDC payout

PUSDC's deployed `ConfidentialUSDC` uses the pre-v0.1.0 `euint64 = uint256` selector, while this contract is compiled against `euint64 = bytes32`. The contract pre-computes the legacy selector once and calls it via low-level `call`:

```solidity
// MuHavenEscrow.sol:81
bytes4 private constant _TRANSFER_UINT256 =
    bytes4(keccak256("confidentialTransfer(address,uint256)"));

// paymentToken.call(abi.encodeWithSelector(_TRANSFER_UINT256, recipient, payoutHandle))
// Payload is built at the call site; failure reverts with a named error.
```

Context: `development/DEV_WAVE_3/PUSDC_TRANSFER_ISSUE.md`.

### Silent-fail event caveat

`EscrowRedeemed` is emitted on every call to `redeem` / `redeemMultiple`, even when the payout is zero because of a failed condition. Off-chain pollers **must** verify the corresponding PUSDC `ConfidentialTransfer` event (or the backend's yield-record status) before marking a yield as claimed. The block poller in `backend/src/infrastructure/event-poller` already does this — SDK consumers watching raw events should do the same.

### Gas (not benchmarked on testnet)

Approximate budgets from implementation inspection + test traces:

| Operation | Cost per escrow | Practical ceiling per tx (Arb Sepolia, 30M block) |
|-----------|-----------------|---------------------------------------------------|
| `batchCreate` | ~300–500k (ZK validation + resolver callback) | ~50 |
| `fundFrom` | ~60–120k | — (single escrow call) |
| `redeemMultiple` | ~1M (owner eq + resolver read + two AND + select) | ~20–30 |

The SDK defaults to `DEFAULT_BATCH_SIZE = 50` for `batchCreate` and recommends ≤ 30 for `redeemMultiple`.

---

## 10. EIP Standards Compliance

This section maps MuHaven's contracts and planned features to Ethereum standards, with rationale for deviations.

### Implemented

| EIP | Where | Notes |
|-----|-------|-------|
| **EIP-165** (introspection) | All proxy-backed contracts via `ERC165Upgradeable` | Used by the SDK to sanity-check addresses at construction time. |
| **EIP-1967 / EIP-1822** (transparent proxies) | `MuHavenToken`, `MuHavenVault`, `InvestorRegistry`, `YieldDistributor`, `RiskParams`, `MuHavenEscrow` | OpenZeppelin Transparent Upgradeable Proxy. Proxy + implementation addresses recorded in `deployments/arb-sepolia.json`. |
| **EIP-712** (typed signed data) | Auth flow (SIWE-style nonce/verify), permit-based FHE decryption (`FHE.allow` + `decryptForView`) | Frontend signs EIP-712 payloads via ZeroDev passkey kernel. |
| **EIP-4337** (account abstraction) | Frontend — ZeroDev kernel smart accounts | All user writes are UserOps, not EOA transactions. See `development/DEV_WAVE_3/HOMELAB_DEPLOY.md` for bundler/paymaster config. |

### Partial / scoped

| EIP | Status | What's there | What's planned |
|-----|--------|--------------|----------------|
| **ERC-3643** (T-REX, regulated securities) | Partial | `ERC3643KYCAdapter` implements the `IKYCGate` surface that `MuHavenToken._beforeTokenTransfer` consults. Tier 1 (retail) + tier 2 (accredited) claim topics modeled. | Full ONCHAINID integration — read claims directly from `IIdentity` / `IClaimIssuer`, verify claim signatures + expiries. Hackathon uses a simple whitelist inside the adapter. |

### Planned / aspirational (not yet shipped)

| EIP | Target | Rationale |
|-----|--------|-----------|
| **ERC-4626** (tokenized vault standard) | `MuHavenVault` | Would make the vault composable with DeFi aggregators. Not prioritized because the vault currently wraps a single underlying per deployment. |
| **ERC-7540** (async deposit/redeem) | `MuHavenVault`, `MuHavenEscrow` | Matches FHE's inherent async nature (coprocessor delay, batch settlement). A natural upgrade path once CoFHE proves stable under sustained load. |
| **EIP-7702** (scoped session keys) | Frontend (currently ZeroDev `@zerodev/permissions`-based session keys) | 7702 lands EOA-native session keys; moving off ZeroDev's kernel-specific permission system would simplify the provider layer. Blocked on 7702 finalization + wallet support. |
| **ERC-8004** (agent identity) | Future AI-agent integration | Combines with x402 agent-to-agent payments — both are post-hackathon. |

### Deliberate deviations

**fhERC-20 vs ERC-20 vs [ERC-7984](https://eips.ethereum.org/EIPS/eip-7984) (confidential ERC-20 draft).**
MuHavenToken is an fhERC-20 — balances are `euint128`, transfers take `InEuint128` encrypted inputs, all state mutations go through `FHE.add` / `FHE.sub` / `FHE.select`. This deviates from plain ERC-20 in the obvious ways (no plaintext `balanceOf`, no plaintext `Transfer(from, to, amount)` event) and also differs from the early ERC-7984 draft in type choice (`euint128` vs `euint64`) and in using permit-based client decryption rather than sealed outputs. As ERC-7984 stabilizes we'll re-evaluate — the type difference is driven by USDC accounting room (euint128 accommodates aggregate RWA positions comfortably; euint64 is tight at ~18.4T with 6 decimals).

**Push yield distribution vs [EIP-2222](https://eips.ethereum.org/EIPS/eip-2222) (pull-based dividends).**
EIP-2222 computes `dividendOf(account)` from a running per-share accumulator — investors pull their share on demand, gas-efficient at scale. MuHaven instead *pushes* a `MuHavenEscrow` per investor per distribution. Rationale: pull-based math leaks balance information via the accumulator interaction (`balanceOf * (accumulated - last)`), which defeats the privacy guarantee. The per-investor escrow keeps each share encrypted end-to-end, at the cost of O(N) escrows per distribution. Batch size tuning + the two-phase create / fund split keeps this tractable in practice.

**Silent-fail events vs traditional revert-on-error.**
Standard EVM contracts revert on authorization failures. MuHavenEscrow intentionally emits `EscrowRedeemed` unconditionally, so that a wrong-caller redemption attempt is indistinguishable on-chain from a correct one. Integrators must verify PUSDC movement — the trade-off is documented in every consumer (SDK caveats, backend poller, this doc).

---

## Deployment

### Setup

```bash
npm install -g pnpm
pnpm install
```

The repo is forked from `cofhe-hardhat-starter` (branch `sdk-migration`) — no separate clone needed.

### Deploy script

The canonical deploy lives at `scripts/deploy.ts` and handles all 8 contracts in dependency order. Use the pnpm wrappers:

```bash
pnpm run deploy:local            # Hardhat in-process network (auto-deploys mocks)
pnpm run deploy:testnet          # Arbitrum Sepolia — reads .env for issuer / USDC / underlying
pnpm run deploy:mocks:testnet    # Deploy TestTreasury standalone for vault testing
```

Deploy order (from `scripts/deploy.ts`):

1. **ERC3643KYCAdapter** (standalone)
2. **InvestorRegistry** (proxy) — initialized later with `tokenContract`
3. **MuHavenToken** (proxy) — depends on KYC adapter + InvestorRegistry
4. **RiskParams** (proxy)
5. **YieldGate** (standalone) — depends on MuHavenToken + KYC adapter
6. **MuHavenEscrow** (proxy) — initialized with deployer + PUSDC
7. **YieldDistributor** (proxy) — depends on MuHavenToken + MuHavenEscrow + YieldGate + InvestorRegistry
8. **MuHavenVault** (proxy) — depends on underlying ERC-20 + MuHavenToken, granted `MINTER_ROLE`

Post-deploy, the script wires `YieldDistributor` as an authorized caller on `MuHavenEscrow`, grants minter roles, and writes proxy + implementation addresses to `deployments/arb-sepolia.json`.

### Deployed addresses (Arb Sepolia)

See [`deployments/arb-sepolia.json`](../deployments/arb-sepolia.json) for the authoritative list. All proxies + implementations are verified on Arbiscan. The README mirrors this table in the project overview.

### Testing

```bash
pnpm test                                   # All tests (~180, mock FHE environment)
pnpm test test/MuHavenEscrow.test.ts        # Single test file
pnpm test test/MuHavenSdk.integration.test.ts   # SDK integration suite (25 cases)
```
