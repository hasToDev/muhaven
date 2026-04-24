// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ERC165Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/introspection/ERC165Upgradeable.sol";
import {
    FHE,
    euint128,
    ebool,
    InEuint128,
    Common,
    ITaskManager,
    TASK_MANAGER_ADDRESS
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IKYCGate} from "./interfaces/IKYCGate.sol";
import {IInvestorRegistry} from "./interfaces/IInvestorRegistry.sol";
import {IMuHavenToken} from "./interfaces/IMuHavenToken.sol";
import {IMuHavenIdentityRegistry} from "./interfaces/IMuHavenIdentityRegistry.sol";
import {IModularCompliance} from "./interfaces/IModularCompliance.sol";

/// @title MuHavenToken
/// @notice fhERC-20 RWA token with encrypted balances, transfers, and approvals.
///         Uses Fhenix CoFHE for all balance/amount operations.
///         Deployed behind an OZ Transparent Proxy.
///
/// @dev Privacy architecture:
///   - Balances stored as `euint128` — never visible on-chain in plaintext.
///   - Transfer amounts are encrypted client-side via `InEuint128` — calldata
///     contains only a ciphertext hash, security zone, and ZK proof.
///   - `FHE.allow(balance, ephemeralEOA)` grants permit-based decryption per
///     ADR-009 / ADR-021: every mutation producing user-decryptable state
///     accepts an `ephemeralEOA` parameter and grants it decrypt rights on the
///     new handle. The user's kernel address is also granted for legacy
///     compatibility but cannot actually sign permits (ERC-1271 / ERC-6492
///     gap — see `development/PRODUCTION_DESIGN/PERMIT_DECRYPT_LIFECYCLE.md`).
///   - `FHE.select()` silent failure ensures that insufficient-balance transfers
///     execute an identical code path (same gas, same trace) as valid transfers —
///     an observer cannot distinguish success from failure.
///   - Total supply is encrypted by default. The issuer can optionally reveal it
///     via `setTotalSupplyPublic()` (one-way toggle using `FHE.allowPublic`).
///
///   Wave 3.5 delta (per ADR-006 / ADR-021 / ADR-022 / ADR-026):
///   - New `SUBSCRIPTION_ROLE` gates `mintFromSubscription` /
///     `burnFromSubscription` — the only paid-settlement path. Granted to the
///     single `MuHavenSubscription` contract via `setSubscription`.
///   - Wave 3's initialize-time `minters[_issuer] = true` auto-grant is
///     removed. Issuer holds **zero** mint authority; compromised issuer keys
///     cannot conjure shares.
///   - `transfer` / `transferFrom` now also exist as ephemeralEOA-aware
///     overloads and call `IInvestorRegistry.addHolder(address(this),
///     recipient)` on every call (idempotent) so P2P recipients are visible
///     to the per-token holder API (YieldSnapshot, MaxHolders).
///   - `authorizedReaders` mapping is reserved for Wave 4 (agent-side
///     encrypted-balance reads). The slot and its admin setter are live;
///     no read paths consume it yet.
///
///   Known leakage (by design):
///   - `Transfer(from, to)` events expose participant addresses. This is
///     intentional: addresses are already visible in transaction calldata.
///     Transfer *amounts* are never emitted.
///   - `MinterGranted`/`MinterRevoked` events expose role assignments.
///   - KYC eligibility check (`kycGate.isEligible`) is a cleartext boolean —
///     the result (revert or proceed) is observable, but no private data leaks.
contract MuHavenToken is Initializable, PausableUpgradeable, ERC165Upgradeable, IMuHavenToken {

    // ── Storage ──────────────────────────────────────────────────────────

    mapping(address => euint128) private _balances;
    mapping(address => mapping(address => euint128)) private _allowances;
    euint128 private _encryptedTotalSupply;

    string private _name;
    string private _symbol;

    address public usdcAddress;
    IKYCGate public kycGate;
    IInvestorRegistry public registry;
    address public owner;
    address public issuer;

    mapping(address => bool) public minters;

    /// @dev Once set to true via setTotalSupplyPublic(), the encrypted total
    ///      supply becomes publicly decryptable via threshold decryption.
    ///      One-way toggle: FHE.allowPublic() is irreversible for that handle.
    bool public totalSupplyPublic;

    // ── Wave 3.5 additions (ADR-006 / ADR-021) ───────────────────────────

    /// @notice Single authorised `MuHavenSubscription` contract — the only
    ///         caller of `mintFromSubscription` / `burnFromSubscription`.
    address public subscription;

    /// @notice Reserved for Wave 4 agent-side encrypted-balance reads.
    ///         Not consumed by any Wave 3.5 read path; set via
    ///         `setAuthorizedReader` as a forward-compatibility hook.
    mapping(address => bool) public authorizedReaders;

    // ── Wave 3.5 Phase 3: ERC-3643 compliance wiring (ADR-011) ──────────

    /// @notice Phase 3 identity registry. When non-zero, supersedes
    ///         `kycGate` for eligibility checks on mint / transfer.
    address public identityRegistry;

    /// @notice Phase 3 modular compliance coordinator. When non-zero, every
    ///         transfer / mint / burn consults `canTransfer` and fires the
    ///         appropriate state hook (`created` / `transferred` /
    ///         `destroyed`). Zero ⇒ compliance is not gated by this token.
    address public modularCompliance;

    /// @dev Reserved storage for future upgrades. Decremented by 4 slots to
    ///      accommodate `subscription`, `authorizedReaders`,
    ///      `identityRegistry`, and `modularCompliance` above, preserving
    ///      the total storage footprint (proxy-safe).
    uint256[46] private __gap;

    // ── Events ───────────────────────────────────────────────────────────

    event Transfer(address indexed from, address indexed to);
    event Approval(address indexed owner, address indexed spender);
    event KYCGateUpdated(address indexed newGate);
    event IssuerUpdated(address indexed newIssuer);
    event RegistryUpdated(address indexed newRegistry);
    event MinterGranted(address indexed minter);
    event MinterRevoked(address indexed minter);
    event SubscriptionUpdated(address indexed newSubscription);
    event AuthorizedReaderUpdated(address indexed reader, bool authorized);
    event BalanceDecryptRequested(address indexed account);
    event TotalSupplyMadePublic();
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event IdentityRegistryUpdated(address indexed newRegistry);
    event ModularComplianceUpdated(address indexed newCompliance);

    // ── Errors ───────────────────────────────────────────────────────────

    error OnlyOwner();
    error OnlyMinter();
    error OnlySubscription();
    error RecipientNotKYC();
    error NoBalance();
    error ZeroAddress();
    error AlreadyPublic();
    error InvalidEphemeralEOA();
    error ComplianceBlocked();

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyMinter() {
        if (!minters[msg.sender]) revert OnlyMinter();
        _;
    }

    modifier onlySubscription() {
        // `msg.sender` is always non-zero in a real call, so comparing against
        // `subscription` also rejects the unset (address(0)) case implicitly.
        if (msg.sender != subscription) revert OnlySubscription();
        _;
    }

    // ── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes a fresh MuHavenToken proxy.
    /// @dev Wave 3.5 delta (ADR-006): no automatic `minters[_issuer] = true`
    ///      auto-grant. Issuer holds zero mint authority by default. The
    ///      Subscription is wired separately via `setSubscription`, and the
    ///      Vault (legacy wrap path) via `grantMinter` as in Wave 3.
    function initialize(
        string memory name_,
        string memory symbol_,
        address _kycGate,
        address _registry,
        address _issuer,
        address _usdcAddress
    ) external initializer {
        if (_kycGate == address(0) || _registry == address(0) || _issuer == address(0))
            revert ZeroAddress();

        __Pausable_init();
        __ERC165_init();

        _name = name_;
        _symbol = symbol_;
        kycGate = IKYCGate(_kycGate);
        registry = IInvestorRegistry(_registry);
        issuer = _issuer;
        usdcAddress = _usdcAddress;
        owner = msg.sender;
    }

    // ── View helpers ─────────────────────────────────────────────────────

    function name() external view returns (string memory) { return _name; }
    function symbol() external view returns (string memory) { return _symbol; }
    function decimals() external pure returns (uint8) { return 18; }

    // ── Phase 3 eligibility / compliance helpers ─────────────────────────

    /// @dev Resolved KYC check. Uses `identityRegistry.isVerified` when the
    ///      Phase 3 registry is wired, otherwise falls back to the Wave 3
    ///      `kycGate.isEligible` so this contract keeps working pre-cutover.
    function _isEligible(address account) internal view returns (bool) {
        address reg = identityRegistry;
        if (reg != address(0)) {
            return IMuHavenIdentityRegistry(reg).isVerified(account);
        }
        return kycGate.isEligible(account);
    }

    /// @dev Modular compliance gate. No-op when no coordinator is wired.
    ///      Called before any FHE work on the P2P transfer path.
    function _requireCompliance(address from, address to, uint256 amount) internal view {
        address comp = modularCompliance;
        if (comp == address(0)) return;
        if (!IModularCompliance(comp).canTransfer(address(this), from, to, amount)) {
            revert ComplianceBlocked();
        }
    }

    /// @dev State-hook dispatch. No-op when no coordinator is wired. Called
    ///      after successful state changes so stateful modules (MaxHolders,
    ///      MaxBalance, Lockup) can update their counters.
    function _notifyMint(address to, uint256 amount) internal {
        address comp = modularCompliance;
        if (comp == address(0)) return;
        IModularCompliance(comp).created(address(this), to, amount);
    }

    function _notifyBurn(address from, uint256 amount) internal {
        address comp = modularCompliance;
        if (comp == address(0)) return;
        IModularCompliance(comp).destroyed(address(this), from, amount);
    }

    function _notifyTransfer(address from, address to, uint256 amount) internal {
        address comp = modularCompliance;
        if (comp == address(0)) return;
        IModularCompliance(comp).transferred(address(this), from, to, amount);
    }

    // ── Mint (Wave 3 encrypted-input path — kept for test scaffolding) ──

    /// @notice Mints encrypted tokens to a KYC-eligible recipient. Caller must
    ///         hold `MINTER_ROLE` (Wave 3 legacy; in Wave 3.5 production only
    ///         the Vault is granted, and it calls `mintFromVault` instead).
    /// @dev Wave 3 signature preserved for test + diagnostic scripts. New
    ///      paid-settlement mints go through `mintFromSubscription` which
    ///      requires an `ephemeralEOA` per ADR-021.
    function mint(address to, InEuint128 memory encryptedAmount) external onlyMinter whenNotPaused {
        if (!_isEligible(to)) revert RecipientNotKYC();
        // Amount is encrypted; modules get 0 as a cleartext placeholder. Amount-
        // aware rules (MaxBalance) are loose on this path — Wave 3 scaffolding,
        // not a production entry point.
        _requireCompliance(address(0), to, 0);

        euint128 amount = FHE.asEuint128(encryptedAmount);
        FHE.allowThis(amount);

        _mintInternal(to, amount, address(0));
        _notifyMint(to, 0);
    }

    // ── Mint (cleartext input — vault path) ──────────────────────────────

    function mintFromVault(address to, uint256 amount) external onlyMinter whenNotPaused {
        if (!_isEligible(to)) revert RecipientNotKYC();
        // Vault path has cleartext amount — pass through so amount-aware
        // modules (MaxBalance) can evaluate accurately.
        _requireCompliance(address(0), to, amount);

        euint128 encAmount = FHE.asEuint128(amount);
        FHE.allowThis(encAmount);

        _mintInternal(to, encAmount, address(0));
        _notifyMint(to, amount);
    }

    // ── Mint (Wave 3.5 paid-settlement path — Subscription only) ────────

    /// @notice Mints `encAmount` shares to `to` on behalf of a paid purchase
    ///         executed through `MuHavenSubscription`. Grants decrypt access
    ///         on the new balance handle to `ephemeralEOA` per ADR-021.
    /// @dev Caller is always the authorised Subscription contract. Subscription
    ///      has already enforced KYC/compliance/cap gates — the KYC check here
    ///      is a belt-and-braces defense (cheap cleartext) in case a future
    ///      Subscription upgrade skips it.
    function mintFromSubscription(
        address to,
        euint128 encAmount,
        address ephemeralEOA
    ) external onlySubscription whenNotPaused {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (!_isEligible(to)) revert RecipientNotKYC();

        // Subscription allows encAmount to this contract before the call, but
        // explicit allowThis is safe and defensive against future changes.
        FHE.allowThis(encAmount);

        _mintInternal(to, encAmount, ephemeralEOA);
    }

    function _mintInternal(address to, euint128 amount, address ephemeralEOA) internal {
        if (Common.isInitialized(_balances[to])) {
            _balances[to] = FHE.add(_balances[to], amount);
        } else {
            _balances[to] = amount;
        }
        FHE.allowThis(_balances[to]);

        // Wave 3 legacy: kernel address grant (not permit-signable per
        // ADR-009, but harmless and matches Wave 3 behaviour).
        FHE.allow(_balances[to], to);

        // Wave 3.5 canonical: ephemeralEOA grant — the only grant a frontend
        // permit can actually validate against.
        if (ephemeralEOA != address(0)) {
            FHE.allow(_balances[to], ephemeralEOA);
        }

        if (Common.isInitialized(_encryptedTotalSupply)) {
            _encryptedTotalSupply = FHE.add(_encryptedTotalSupply, amount);
        } else {
            _encryptedTotalSupply = amount;
        }
        FHE.allowThis(_encryptedTotalSupply);
        if (totalSupplyPublic) {
            FHE.allowPublic(_encryptedTotalSupply);
        }

        registry.addHolder(address(this), to);
        emit Transfer(address(0), to);
    }

    // ── Transfer — Wave 3 legacy overload (no ephemeralEOA) ─────────────

    /// @notice Wave 3 legacy transfer. Grants kernel-only decrypt on the new
    ///         balance handles. Use the three-arg overload in Wave 3.5 flows
    ///         to get the ADR-021 ephemeral-EOA grant.
    function transfer(address to, InEuint128 memory encryptedAmount) external whenNotPaused {
        if (!_isEligible(to)) revert RecipientNotKYC();
        // Amount encrypted; cleartext placeholder=0 for compliance modules.
        // Amount-aware rules are loose on P2P paths per ADR-019's known-loose
        // behaviour — tightened when an FHE-native compliance variant lands.
        _requireCompliance(msg.sender, to, 0);

        euint128 amount = FHE.asEuint128(encryptedAmount);
        FHE.allowThis(amount);

        _transfer(msg.sender, to, amount, address(0));
        _notifyTransfer(msg.sender, to, 0);
    }

    /// @notice Wave 3.5 canonical transfer. Grants `ephemeralEOA` decrypt
    ///         access on the sender's updated balance handle per ADR-021.
    ///         The recipient's balance handle still gets only a kernel grant;
    ///         a dedicated refresh path (deferred) lets the recipient rotate
    ///         to their own ephemeralEOA on-demand — see
    ///         `PERMIT_DECRYPT_LIFECYCLE.md §8 Q4`.
    function transfer(
        address to,
        InEuint128 memory encryptedAmount,
        address ephemeralEOA
    ) external whenNotPaused {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (!_isEligible(to)) revert RecipientNotKYC();
        _requireCompliance(msg.sender, to, 0);

        euint128 amount = FHE.asEuint128(encryptedAmount);
        FHE.allowThis(amount);

        _transfer(msg.sender, to, amount, ephemeralEOA);
        _notifyTransfer(msg.sender, to, 0);
    }

    // ── TransferFrom — Wave 3 legacy + Wave 3.5 canonical overloads ────

    function transferFrom(
        address from,
        address to,
        InEuint128 memory encryptedAmount
    ) external whenNotPaused {
        if (!_isEligible(to)) revert RecipientNotKYC();
        _requireCompliance(from, to, 0);

        euint128 amount = FHE.asEuint128(encryptedAmount);
        FHE.allowThis(amount);

        _transferFrom(from, to, amount, address(0));
        _notifyTransfer(from, to, 0);
    }

    function transferFrom(
        address from,
        address to,
        InEuint128 memory encryptedAmount,
        address ephemeralEOA
    ) external whenNotPaused {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (!_isEligible(to)) revert RecipientNotKYC();
        _requireCompliance(from, to, 0);

        euint128 amount = FHE.asEuint128(encryptedAmount);
        FHE.allowThis(amount);

        _transferFrom(from, to, amount, ephemeralEOA);
        _notifyTransfer(from, to, 0);
    }

    function _transferFrom(
        address from,
        address to,
        euint128 amount,
        address ephemeralEOA
    ) internal {
        // Silent failure: if allowance < amount, effective amount is zero
        ebool allowanceOk = FHE.gte(_allowances[from][msg.sender], amount);
        euint128 zero = FHE.asEuint128(uint256(0));
        FHE.allowThis(zero);
        euint128 approvedAmount = FHE.select(allowanceOk, amount, zero);
        FHE.allowThis(approvedAmount);

        // Deduct allowance
        _allowances[from][msg.sender] = FHE.sub(_allowances[from][msg.sender], approvedAmount);
        FHE.allowThis(_allowances[from][msg.sender]);

        _transfer(from, to, approvedAmount, ephemeralEOA);
    }

    /// @dev Internal transfer with silent-failure pattern.
    ///      If sender balance < amount, transfers zero instead of reverting.
    ///
    ///      Side-channel resistance: FHE.select() executes an identical code path
    ///      regardless of whether the balance check passes. Gas cost and execution
    ///      trace are the same for valid and invalid transfers — an observer cannot
    ///      distinguish "transferred 100" from "transferred 0 (insufficient balance)".
    ///
    ///      `ephemeralEOA == address(0)` is the Wave 3 legacy path — kernel-only
    ///      ACL grants. Non-zero is Wave 3.5 canonical — sender's new balance
    ///      handle additionally grants `ephemeralEOA`.
    function _transfer(
        address from,
        address to,
        euint128 amount,
        address ephemeralEOA
    ) internal {
        if (!Common.isInitialized(_balances[from])) revert NoBalance();

        // Silent failure: if balance < amount, transfer zero
        ebool hasEnough = FHE.gte(_balances[from], amount);
        euint128 zero = FHE.asEuint128(uint256(0));
        FHE.allowThis(zero);
        euint128 transferAmount = FHE.select(hasEnough, amount, zero);
        FHE.allowThis(transferAmount);

        // Update sender balance
        _balances[from] = FHE.sub(_balances[from], transferAmount);
        FHE.allowThis(_balances[from]);
        // Kernel grant (legacy, always) + ephemeralEOA grant (Wave 3.5 canonical)
        FHE.allow(_balances[from], from);
        if (ephemeralEOA != address(0)) {
            FHE.allow(_balances[from], ephemeralEOA);
        }

        // Update recipient balance
        if (Common.isInitialized(_balances[to])) {
            _balances[to] = FHE.add(_balances[to], transferAmount);
        } else {
            _balances[to] = transferAmount;
        }
        FHE.allowThis(_balances[to]);
        // Recipient always gets a kernel grant. Their own ephemeralEOA grant
        // is their responsibility via a future refresh path — see ADR-028 +
        // PERMIT_DECRYPT_LIFECYCLE §8 Q4.
        FHE.allow(_balances[to], to);

        // ADR-022: register the recipient in the per-token holder set so
        // P2P-received tokens participate in yield snapshots + MaxHolders
        // upper-bound checks. Idempotent at registry level.
        registry.addHolder(address(this), to);
        emit Transfer(from, to);
    }

    // ── Approve ──────────────────────────────────────────────────────────

    function approve(address spender, InEuint128 memory encryptedAmount) external {
        if (spender == address(0)) revert ZeroAddress();

        euint128 amount = FHE.asEuint128(encryptedAmount);
        _allowances[msg.sender][spender] = amount;
        FHE.allowThis(_allowances[msg.sender][spender]);

        emit Approval(msg.sender, spender);
    }

    // ── Burn (Wave 3 vault unwrap path) ──────────────────────────────────

    /// @notice Burns tokens from `from` using cleartext amount. Caller must be a
    ///         minter (vault). Uses silent-failure pattern: if balance < amount,
    ///         burns zero.
    function burnFromVault(address from, uint256 amount) external onlyMinter {
        if (!Common.isInitialized(_balances[from])) revert NoBalance();
        // Vault-driven burn: amount is cleartext, so amount-aware compliance
        // modules get the real value.
        _requireCompliance(from, address(0), amount);

        euint128 encAmount = FHE.asEuint128(amount);
        FHE.allowThis(encAmount);

        _burnInternal(from, encAmount, address(0));
        _notifyBurn(from, amount);
    }

    // ── Burn (Wave 3.5 paid-settlement path — Subscription only) ────────

    /// @inheritdoc IMuHavenToken
    /// @dev Returns the silent-fail-bounded actual burn amount so the caller
    ///      (Subscription) can mirror it into the PUSDC payout leg — paying
    ///      proceeds for the requested amount when the user lacks sufficient
    ///      balance would let an investor drain the treasury without holding
    ///      shares. ACL on the returned handle is granted to the caller so it
    ///      can run downstream FHE math on the same handle in this tx.
    function burnFromSubscription(
        address from,
        euint128 encAmount,
        address ephemeralEOA
    ) external onlySubscription returns (euint128 actualBurned) {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (!Common.isInitialized(_balances[from])) revert NoBalance();

        FHE.allowThis(encAmount);

        actualBurned = _burnInternal(from, encAmount, ephemeralEOA);
        // Subscription needs ACL to run `FHE.mul(actualBurned, nav)` for the
        // proceeds compute downstream.
        FHE.allow(actualBurned, msg.sender);
    }

    function _burnInternal(
        address from,
        euint128 encAmount,
        address ephemeralEOA
    ) internal returns (euint128 burnAmount) {
        // Silent failure on insufficient balance
        ebool hasEnough = FHE.gte(_balances[from], encAmount);
        euint128 zero = FHE.asEuint128(uint256(0));
        FHE.allowThis(zero);
        burnAmount = FHE.select(hasEnough, encAmount, zero);
        FHE.allowThis(burnAmount);

        _balances[from] = FHE.sub(_balances[from], burnAmount);
        FHE.allowThis(_balances[from]);
        FHE.allow(_balances[from], from);
        if (ephemeralEOA != address(0)) {
            FHE.allow(_balances[from], ephemeralEOA);
        }

        _encryptedTotalSupply = FHE.sub(_encryptedTotalSupply, burnAmount);
        FHE.allowThis(_encryptedTotalSupply);
        if (totalSupplyPublic) {
            FHE.allowPublic(_encryptedTotalSupply);
        }

        emit Transfer(from, address(0));
    }

    // ── Encrypted balance views (for contract-to-contract use) ───────────

    function encryptedBalanceOf(address account) external view returns (euint128) {
        return _balances[account];
    }

    function encryptedTotalSupply() external view returns (euint128) {
        return _encryptedTotalSupply;
    }

    // ── Async decrypt for balance viewing (Pattern: createDecryptTask) ───
    // NOTE: The recommended pattern is client-side decryptForView() via CoFHE SDK.
    // This on-chain async flow is kept for backwards compatibility.

    /// @notice Request async decryption of the caller's own balance.
    ///         Result can be read later via getBalanceDecryptResult().
    function requestBalanceDecrypt() external {
        if (!Common.isInitialized(_balances[msg.sender])) revert NoBalance();
        FHE.allow(_balances[msg.sender], msg.sender);
        ITaskManager(TASK_MANAGER_ADDRESS).createDecryptTask(
            uint256(euint128.unwrap(_balances[msg.sender])),
            msg.sender
        );
        emit BalanceDecryptRequested(msg.sender);
    }

    /// @notice Read the async-decrypted balance for an account.
    /// @return result     The decrypted uint128 value (only meaningful if decrypted == true).
    /// @return decrypted  Whether the decryption has completed.
    function getBalanceDecryptResult(address account)
        external
        view
        returns (uint128 result, bool decrypted)
    {
        return FHE.getDecryptResultSafe(_balances[account]);
    }

    // ── Total supply visibility toggle ───────────────────────────────────

    /// @notice Make the encrypted total supply publicly decryptable via
    ///         threshold decryption. One-way: once public, it cannot be
    ///         re-encrypted. Subsequent mint/burn operations re-grant public
    ///         access on the new total supply handle automatically.
    ///
    ///         Use case: securities tokens where regulators or the public need
    ///         to verify aggregate supply, while individual balances stay private.
    function setTotalSupplyPublic() external onlyOwner {
        if (totalSupplyPublic) revert AlreadyPublic();
        totalSupplyPublic = true;
        if (Common.isInitialized(_encryptedTotalSupply)) {
            FHE.allowPublic(_encryptedTotalSupply);
        }
        emit TotalSupplyMadePublic();
    }

    // ── Pausable ─────────────────────────────────────────────────────────

    /// @notice Pause mint, transfer, and transferFrom. Exit path (burnFromVault)
    ///         remains open so investors can always unwrap via MuHavenVault.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ── Access control — owner functions ─────────────────────────────────

    function grantMinter(address minter) external onlyOwner {
        if (minter == address(0)) revert ZeroAddress();
        minters[minter] = true;
        emit MinterGranted(minter);
    }

    function revokeMinter(address minter) external onlyOwner {
        minters[minter] = false;
        emit MinterRevoked(minter);
    }

    /// @notice Set the authorised `MuHavenSubscription` contract. Wave 3.5
    ///         gate for `mintFromSubscription` / `burnFromSubscription`.
    ///         Passing `address(0)` disables the paid-settlement path.
    function setSubscription(address newSubscription) external onlyOwner {
        subscription = newSubscription;
        emit SubscriptionUpdated(newSubscription);
    }

    /// @notice Mark `reader` as authorised for Wave 4 agent-side encrypted-balance
    ///         reads. Wave 3.5 exposes the slot + setter only; no read paths
    ///         consume `authorizedReaders` yet.
    function setAuthorizedReader(address reader, bool authorized) external onlyOwner {
        if (reader == address(0)) revert ZeroAddress();
        authorizedReaders[reader] = authorized;
        emit AuthorizedReaderUpdated(reader, authorized);
    }

    function setKYCGate(address newGate) external onlyOwner {
        if (newGate == address(0)) revert ZeroAddress();
        kycGate = IKYCGate(newGate);
        emit KYCGateUpdated(newGate);
    }

    /// @notice Wire the Phase 3 identity registry. Non-zero supersedes the
    ///         Wave 3 `kycGate` for `_isEligible` checks. Pass `address(0)`
    ///         to revert to legacy gating.
    function setIdentityRegistry(address newRegistry) external onlyOwner {
        identityRegistry = newRegistry;
        emit IdentityRegistryUpdated(newRegistry);
    }

    /// @notice Wire the Phase 3 modular compliance coordinator. Zero
    ///         disables compliance gating on this token.
    function setModularCompliance(address newCompliance) external onlyOwner {
        modularCompliance = newCompliance;
        emit ModularComplianceUpdated(newCompliance);
    }

    function setIssuer(address newIssuer) external onlyOwner {
        if (newIssuer == address(0)) revert ZeroAddress();
        issuer = newIssuer;
        emit IssuerUpdated(newIssuer);
    }

    function setRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert ZeroAddress();
        registry = IInvestorRegistry(newRegistry);
        emit RegistryUpdated(newRegistry);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    // ── EIP-165 ──────────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override
        returns (bool)
    {
        return interfaceId == type(IMuHavenToken).interfaceId
            || super.supportsInterface(interfaceId);
    }
}
