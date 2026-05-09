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

    // ── Wave 3.5 Phase 4: RedemptionQueue wiring (ADR-035) ───────────────

    /// @notice Single authorised `RedemptionQueue` contract — the only
    ///         caller of `pullFromInvestor` / `returnToInvestor` /
    ///         `burnFromQueue`.
    address public queue;

    // ── Wave 3.5 Phase 5: YieldSnapshot wiring (ADR-037) ─────────────────

    /// @notice Single authorised `YieldSnapshot` contract — the only caller
    ///         of `snapshotBalance` / `snapshotTotalSupply`. Needed so the
    ///         snapshot reader can gain FHE ACL access on balance handles
    ///         owned by this token; without it, downstream `FHE.mul` inside
    ///         `claimYield` would revert ACL-denied.
    address public yieldSnapshot;

    /// @dev Reserved storage for future upgrades. Decremented by 6 slots to
    ///      accommodate `subscription`, `authorizedReaders`,
    ///      `identityRegistry`, `modularCompliance`, `queue`, and
    ///      `yieldSnapshot` above, preserving the total storage footprint
    ///      (proxy-safe).
    uint256[44] private __gap;

    // ── Events ───────────────────────────────────────────────────────────

    /// @notice Phase 9.A · Option Z follow-up — broadened to carry the
    ///         encrypted `amount` handle so P2P transfers can be audited
    ///         end-to-end on /activity. Mints emit `from = address(0)`,
    ///         burns emit `to = address(0)`, and protocol-mediated moves
    ///         (queue / subscription / treasury) keep the handle so the
    ///         contract's audit grant re-issue surface is uniform across
    ///         all paths. The off-chain indexer filters to true P2P
    ///         (`from != 0 && to != 0` AND neither side is a known
    ///         protocol contract) before persisting an activity row.
    ///         Decrypt requires a permit grant against `from` or `to`
    ///         (both granted at the call site by `_stampTransferAuditAcl`).
    event Transfer(address indexed from, address indexed to, euint128 amount);
    event Approval(address indexed owner, address indexed spender);
    event KYCGateUpdated(address indexed newGate);
    event IssuerUpdated(address indexed newIssuer);
    event RegistryUpdated(address indexed newRegistry);
    event MinterGranted(address indexed minter);
    event MinterRevoked(address indexed minter);
    event SubscriptionUpdated(address indexed newSubscription);
    event QueueUpdated(address indexed newQueue);
    event YieldSnapshotUpdated(address indexed newYieldSnapshot);
    event AuthorizedReaderUpdated(address indexed reader, bool authorized);
    event BalanceDecryptRequested(address indexed account);
    event TotalSupplyMadePublic();
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event IdentityRegistryUpdated(address indexed newRegistry);
    event ModularComplianceUpdated(address indexed newCompliance);
    event DecryptGrantRefreshed(address indexed holder, address indexed ephemeralEOA);
    /// @notice Phase 9.A · Option Z follow-up — emitted when a caller
    ///         re-grants ACL on a historical Transfer audit handle to a
    ///         fresh ephemeralEOA. Mirrors `MuHavenStable.AuditGrantRefreshed`.
    event AuditGrantRefreshed(address indexed owner, address indexed ephemeralEOA, euint128 handle);

    // ── Errors ───────────────────────────────────────────────────────────

    error OnlyOwner();
    error OnlyMinter();
    error OnlySubscription();
    error OnlyQueue();
    error OnlyYieldSnapshot();
    error OnlyAuthorizedReader();
    error RecipientNotKYC();
    error NoBalance();
    error ZeroAddress();
    error AlreadyPublic();
    error InvalidEphemeralEOA();
    error ComplianceBlocked();
    /// @notice Phase 9.A · Option Z follow-up — `refreshAuditGrant` caller
    ///         lacks ACL on the supplied audit handle. Loud-revert so a
    ///         misconfigured frontend doesn't silently emit grant events
    ///         for handles the caller never owned.
    error NotAuditHandleOwner();

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

    modifier onlyQueue() {
        if (msg.sender != queue) revert OnlyQueue();
        _;
    }

    modifier onlyYieldSnapshot() {
        if (msg.sender != yieldSnapshot) revert OnlyYieldSnapshot();
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
        // Phase 9.A · Option Z follow-up — stamp ACL on the amount handle so
        // it's decryptable via permit on the recipient's audit row. Mints
        // grant `to` (kernel) + `ephemeralEOA` (when provided); off-chain
        // the indexer skips mints (filtered as `from == 0`) so the grant is
        // unused by /activity but kept consistent for any future audit
        // tooling that reads Transfer logs directly.
        _stampTransferAuditAcl(amount, address(0), to);
        emit Transfer(address(0), to, amount);
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

        // Update recipient balance.
        //
        // Privacy invariant (Phase 9.A · Option Z follow-up · 2026-05-09
        // hardening): `_balances[to]` MUST be a FRESH handle, not an
        // alias of `transferAmount`. Reason: `_stampTransferAuditAcl`
        // below grants `from` ACL on the audit handle so the sender can
        // decrypt their /activity row. CoFHE ACLs are keyed by handle ID
        // — if `_balances[to]` aliases the audit handle, granting
        // `from` ACL on the audit handle implicitly grants the sender's
        // kernel ACL on the recipient's balance handle, leaking the
        // recipient's post-transfer balance to the sender. The
        // `FHE.add` path on the initialised branch produces a fresh
        // handle organically; the first-receipt branch needs an
        // explicit `FHE.add(zero, …)` to match. One extra FHE op per
        // first-time recipient — cheap insurance for a privacy bug
        // that would otherwise be silent. Same fix applied to
        // `pullFromInvestor` + `returnToInvestor` in this commit.
        if (Common.isInitialized(_balances[to])) {
            _balances[to] = FHE.add(_balances[to], transferAmount);
        } else {
            _balances[to] = FHE.add(zero, transferAmount);
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
        // Phase 9.A · Option Z follow-up — stamp ACL on the silent-fail-
        // bounded `transferAmount` so BOTH parties can decrypt their
        // audit row on /activity. Sender's eph (when provided) is granted
        // immediately; recipient relies on `refreshAuditGrant` for cross-
        // session decrypts (their kernel-only grant passes the gate).
        // Safe to grant `from` here: the privacy-invariant fix above
        // ensures `_balances[to]` is a distinct handle, so this grant
        // doesn't leak to the recipient's balance.
        _stampTransferAuditAcl(transferAmount, from, to);
        emit Transfer(from, to, transferAmount);
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

        // Phase 9.A · Option Z follow-up — burn audit handle stamping. Off-
        // chain the indexer skips burns (filtered as `to == 0`) so this
        // grant doesn't surface on /activity, but it keeps the per-emit
        // grant convention uniform.
        _stampTransferAuditAcl(burnAmount, from, address(0));
        emit Transfer(from, address(0), burnAmount);
    }

    // ── Wave 3.5 paid-settlement path — RedemptionQueue only (ADR-035) ───

    /// @inheritdoc IMuHavenToken
    /// @dev Silent-fail pull from `from` (investor) to the queue. Returns
    ///      the actually-pulled handle per ADR-036 so the queue can store
    ///      the silent-fail-bounded amount in its request struct — matches
    ///      the `burnFromSubscription` return-value pattern (ADR-030).
    ///      Skips KYC + compliance gates on `from`: the queue handles them
    ///      at its `submit` / `submitFor` entry.
    function pullFromInvestor(
        address from,
        euint128 encAmount,
        address ephemeralEOA
    ) external onlyQueue whenNotPaused returns (euint128 actualPulled) {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (!Common.isInitialized(_balances[from])) revert NoBalance();

        FHE.allowThis(encAmount);

        // Silent-fail on insufficient investor balance (Rule 5).
        ebool hasEnough = FHE.gte(_balances[from], encAmount);
        euint128 zero = FHE.asEuint128(uint256(0));
        FHE.allowThis(zero);
        actualPulled = FHE.select(hasEnough, encAmount, zero);
        FHE.allowThis(actualPulled);

        // Deduct from investor. Grant investor's own kernel + ephemeralEOA
        // decrypt on the new balance handle.
        _balances[from] = FHE.sub(_balances[from], actualPulled);
        FHE.allowThis(_balances[from]);
        FHE.allow(_balances[from], from);
        FHE.allow(_balances[from], ephemeralEOA);

        // Credit to queue (msg.sender). Kernel-only grant — the queue is a
        // contract, no ephemeralEOA semantics.
        //
        // Privacy invariant (mirrors the `_transfer` fix above): the
        // first-receipt branch must produce a fresh handle, not alias
        // `actualPulled`. `_stampTransferAuditAcl(actualPulled, from,
        // msg.sender)` below grants `from` (the investor) ACL on the
        // audit handle; if the queue's balance aliased it, the
        // investor would get ACL on the queue's aggregate balance.
        // Practically unreachable today (kernel can't sign permits;
        // on-chain async decrypt only reads `_balances[msg.sender]`),
        // but the invariant should hold structurally so future ACL-
        // surface changes don't accidentally make it exploitable.
        if (Common.isInitialized(_balances[msg.sender])) {
            _balances[msg.sender] = FHE.add(_balances[msg.sender], actualPulled);
        } else {
            _balances[msg.sender] = FHE.add(zero, actualPulled);
        }
        FHE.allowThis(_balances[msg.sender]);
        FHE.allow(_balances[msg.sender], msg.sender);

        // Queue needs ACL on the returned handle to run downstream FHE.mul
        // at processEpoch. Same pattern as burnFromSubscription.
        FHE.allow(actualPulled, msg.sender);

        // Phase 9.A · Option Z follow-up — investor + queue can both decrypt
        // the audit handle via permit. Off-chain the indexer skips this
        // event (queue is in the protocol-filter set) so the grants are
        // not surfaced on /activity but stay consistent with every other
        // emit path.
        _stampTransferAuditAcl(actualPulled, from, msg.sender);
        emit Transfer(from, msg.sender, actualPulled);
    }

    /// @inheritdoc IMuHavenToken
    /// @dev Return shares from the queue's balance to `to` (investor on
    ///      cancel per ADR-027). Skips KYC / compliance — the investor is
    ///      by construction KYC-revoked at the caller's precondition, so a
    ///      compliance gate would block every legitimate cancel.
    function returnToInvestor(
        address to,
        euint128 encAmount,
        address ephemeralEOA
    ) external onlyQueue whenNotPaused {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        // Queue is the sender; its balance must be initialised.
        if (!Common.isInitialized(_balances[msg.sender])) revert NoBalance();

        FHE.allowThis(encAmount);

        // Silent-fail on insufficient queue balance — shouldn't happen in
        // normal operation (queue holds exactly the locked shares) but
        // defence-in-depth costs a single FHE.gte.
        ebool hasEnough = FHE.gte(_balances[msg.sender], encAmount);
        euint128 zero = FHE.asEuint128(uint256(0));
        FHE.allowThis(zero);
        euint128 amount = FHE.select(hasEnough, encAmount, zero);
        FHE.allowThis(amount);

        _balances[msg.sender] = FHE.sub(_balances[msg.sender], amount);
        FHE.allowThis(_balances[msg.sender]);
        FHE.allow(_balances[msg.sender], msg.sender);

        // Privacy invariant (mirrors the `_transfer` + `pullFromInvestor`
        // fixes): first-receipt path must produce a fresh handle, not
        // alias `amount`. `_stampTransferAuditAcl(amount, msg.sender=
        // queue, to=investor)` below grants the queue ACL on the audit
        // handle; aliasing would extend that grant to the investor's
        // balance. Queue is a trusted contract, but the invariant
        // should hold structurally regardless.
        if (Common.isInitialized(_balances[to])) {
            _balances[to] = FHE.add(_balances[to], amount);
        } else {
            _balances[to] = FHE.add(zero, amount);
        }
        FHE.allowThis(_balances[to]);
        FHE.allow(_balances[to], to);
        FHE.allow(_balances[to], ephemeralEOA);

        // Re-register in the holder set. Idempotent at registry level.
        // The investor is still a holder by virtue of their historical
        // balance; this just makes the P2P semantics consistent with
        // other refund paths.
        registry.addHolder(address(this), to);

        // Phase 9.A · Option Z follow-up — queue + investor decrypt grant
        // on the audit handle. Off-chain the indexer skips this event
        // (queue is in the protocol-filter set) so the grants stay
        // off /activity but consistent with the other emit paths. Pass
        // `ephemeralEOA` on the `to` (investor) leg since this is the
        // cancel/refund path.
        _stampTransferAuditAcl(amount, msg.sender, to);
        emit Transfer(msg.sender, to, amount);
    }

    /// @inheritdoc IMuHavenToken
    /// @dev Burn from the queue's own balance. Silent-fails to zero on
    ///      insufficient balance per Rule 5. Returns `actualBurned` for
    ///      the queue's downstream accounting (same pattern as
    ///      `burnFromSubscription`).
    function burnFromQueue(
        euint128 encAmount
    ) external onlyQueue whenNotPaused returns (euint128 actualBurned) {
        if (!Common.isInitialized(_balances[msg.sender])) revert NoBalance();

        FHE.allowThis(encAmount);

        actualBurned = _burnInternal(msg.sender, encAmount, address(0));
        // Grant ACL on actualBurned to the queue so it can mirror into
        // downstream state-hook amount computations.
        FHE.allow(actualBurned, msg.sender);
    }

    // ── Encrypted balance views (for contract-to-contract use) ───────────

    function encryptedBalanceOf(address account) external view returns (euint128) {
        return _balances[account];
    }

    function encryptedTotalSupply() external view returns (euint128) {
        return _encryptedTotalSupply;
    }

    // ── Wave 3.5 Phase 5: YieldSnapshot ACL-grant reads ──────────────────

    /// @inheritdoc IMuHavenToken
    /// @dev Re-grants the caller (the wired `yieldSnapshot`) FHE ACL access
    ///      on the investor's current balance handle and returns it. A
    ///      never-held account maps to a fresh zero-handle (not the
    ///      uninitialised default) so the snapshot reader has a valid input
    ///      for downstream `FHE.mul(encBalance, encRatio)`. Caller-gated so
    ///      arbitrary contracts cannot fish ACL access on private balances.
    function snapshotBalance(address investor) external onlyYieldSnapshot returns (euint128) {
        euint128 b = _balances[investor];
        if (!Common.isInitialized(b)) {
            b = FHE.asEuint128(uint256(0));
            FHE.allowThis(b);
        }
        FHE.allow(b, msg.sender);
        return b;
    }

    /// @inheritdoc IMuHavenToken
    /// @dev Re-grants the caller ACL access on `_encryptedTotalSupply` and
    ///      returns it. Pre-mint state maps to a fresh zero-handle so the
    ///      snapshot finalize path has a usable denominator (though zero
    ///      total supply will be rejected upstream — see YieldSnapshot).
    function snapshotTotalSupply() external onlyYieldSnapshot returns (euint128) {
        euint128 ts = _encryptedTotalSupply;
        if (!Common.isInitialized(ts)) {
            ts = FHE.asEuint128(uint256(0));
            FHE.allowThis(ts);
        }
        FHE.allow(ts, msg.sender);
        return ts;
    }

    // ── Permit/decrypt refresh (ADR-021 + PERMIT_DECRYPT_LIFECYCLE §8 Q4) ─

    /// @notice Re-grant FHE ACL on the caller's own current balance handle
    ///         to `ephemeralEOA`. Self-service, no privilege required beyond
    ///         "I am the balance holder". Emits `DecryptGrantRefreshed`.
    /// @dev Closes the Phase 7 audit gap: a balance handle carries a kernel
    ///      grant after mint / transfer-in / return-to-investor, but the
    ///      kernel cannot sign permits (ADR-009). This primitive lets the
    ///      holder re-bind ACL to a fresh session-scoped ephemeral EOA on
    ///      demand. Applies to three gap scenarios that had no existing
    ///      self-service path:
    ///        1. Fresh kernel that just received a P2P transfer (`_transfer`
    ///           grants kernel only on recipient balance — ADR-028 §8 Q4).
    ///        2. Returning investor on a new browser session whose in-memory
    ///           ephemeral EOA has been regenerated; yesterday's ACL grant is
    ///           on a private key that no longer exists.
    ///        3. Passive holder who never initiated a write op but wants to
    ///           audit their balance.
    ///
    ///      Zero-balance short-circuit: if the caller has never held the
    ///      token (`_balances[msg.sender]` uninitialised) the function
    ///      emits the event and returns. This keeps the primitive idempotent
    ///      and race-free with the frontend calling it unconditionally on
    ///      first decrypt attempt.
    ///
    ///      Privacy: does not leak any new information. The caller's balance
    ///      is already decryptable by the caller via the on-chain async path
    ///      (`requestBalanceDecrypt`) — this just makes the off-chain permit
    ///      path work too.
    /// @notice Phase 9.A · Option Z follow-up — re-grant FHE ACL on a
    ///         HISTORICAL audit handle (the encrypted amount carried in a
    ///         `Transfer` event) to a fresh `ephemeralEOA`. Required because
    ///         each new ZeroDev session mints a fresh ephemeral EOA — the
    ///         transfer-time grant binds to the session-of-origin only, so
    ///         cross-session decrypt of the /activity audit row 403s without
    ///         an explicit rebind.
    /// @dev    Mirrors `MuHavenStable.refreshAuditGrant`. The contract-side
    ///         ACL on `handle` was stamped via `_stampTransferAuditAcl` at
    ///         emit time and is durable, so this contract can call
    ///         `FHE.allow(handle, eph)` even though the originating tx
    ///         finished long ago. The auth gate is `FHE.isAllowed(handle,
    ///         msg.sender)`: only callers whose ACL survives on-chain (the
    ///         original sender or recipient that the emit granted to via
    ///         `FHE.allow(amount, from/to)`) can re-grant. Strangers
    ///         passing in someone else's audit handle bounce here.
    function refreshAuditGrant(euint128 handle, address ephemeralEOA) external {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (!FHE.isAllowed(handle, msg.sender)) revert NotAuditHandleOwner();
        FHE.allow(handle, ephemeralEOA);
        emit AuditGrantRefreshed(msg.sender, ephemeralEOA, handle);
    }

    /// @dev Phase 9.A · Option Z follow-up — stamp the ACL grants needed for
    ///      audit-decrypt of a Transfer's encrypted `amount` handle. Grants
    ///      `allowThis` so the contract can re-grant later via
    ///      `refreshAuditGrant`, plus kernel-only grants on `from` / `to`.
    ///      Address args are skipped when zero (mints / burns).
    ///
    ///      Caller-side invariant (enforced at every call site since
    ///      2026-05-09): the `amount` handle MUST NOT alias any
    ///      live `_balances[*]` handle. CoFHE ACLs are keyed by handle
    ///      ID — granting `from` ACL on `amount` extends that grant to
    ///      every storage slot pointing at the same handle ID. The
    ///      Solidity assignment `_balances[to] = amount` (first-receipt
    ///      paths in `_transfer` / `pullFromInvestor` / `returnToInvestor`)
    ///      previously aliased these handles, leaking the recipient's
    ///      balance ACL to the sender. All such call sites now wrap the
    ///      assignment with `FHE.add(zero, amount)` to mint a fresh
    ///      handle; this function ASSUMES that invariant holds and does
    ///      not re-check.
    ///
    ///      Note: deliberately does NOT grant any ephemeralEOA on the
    ///      amount handle. Both parties use `refreshAuditGrant(handle,
    ///      eph)` on first audit-decrypt instead; same UX shape as
    ///      Wrap/Unwrap cross-session decrypts on /activity.
    function _stampTransferAuditAcl(
        euint128 amount,
        address from,
        address to
    ) internal {
        FHE.allowThis(amount);
        if (from != address(0)) FHE.allow(amount, from);
        if (to != address(0)) FHE.allow(amount, to);
    }

    function refreshDecryptGrant(address ephemeralEOA) external {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (Common.isInitialized(_balances[msg.sender])) {
            // The handle is already allowThis'd from whatever prior op
            // assigned it; re-granting ephemeralEOA costs one FHE.allow.
            FHE.allow(_balances[msg.sender], ephemeralEOA);
        }
        emit DecryptGrantRefreshed(msg.sender, ephemeralEOA);
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

    /// @notice Set the authorised `RedemptionQueue` contract. Wave 3.5
    ///         gate for `pullFromInvestor` / `returnToInvestor` /
    ///         `burnFromQueue`. Passing `address(0)` disables the queue
    ///         primitive surface.
    function setQueue(address newQueue) external onlyOwner {
        queue = newQueue;
        emit QueueUpdated(newQueue);
    }

    /// @notice Set the authorised `YieldSnapshot` contract. Wave 3.5
    ///         gate for `snapshotBalance` / `snapshotTotalSupply` (the
    ///         ACL-grant reads the pull-based yield flow needs). Passing
    ///         `address(0)` disables the snapshot reader surface.
    function setYieldSnapshot(address newYieldSnapshot) external onlyOwner {
        yieldSnapshot = newYieldSnapshot;
        emit YieldSnapshotUpdated(newYieldSnapshot);
    }

    /// @notice Mark `reader` as authorised for Wave 4 agent-side encrypted-balance
    ///         reads. Wave 4 P11 wires the EncryptedGovernance contract here so
    ///         it can re-grant ACL on balance / total-supply handles via
    ///         `getBalanceForGovernance` / `getTotalSupplyForGovernance`.
    function setAuthorizedReader(address reader, bool authorized) external onlyOwner {
        if (reader == address(0)) revert ZeroAddress();
        authorizedReaders[reader] = authorized;
        emit AuthorizedReaderUpdated(reader, authorized);
    }

    // ── Wave 4 P11 — EncryptedGovernance ACL-grant reads ─────────────────

    /// @inheritdoc IMuHavenToken
    /// @dev Mirrors the Phase-5 `snapshotBalance` pattern: re-grants the
    ///      caller FHE ACL on the balance handle and returns it. Fresh
    ///      zero-handle for never-held accounts so the governance vote-weight
    ///      math always has a valid input. Caller-gated to authorised readers
    ///      so arbitrary contracts cannot fish decrypt access.
    function getBalanceForGovernance(address account)
        external
        returns (euint128)
    {
        if (!authorizedReaders[msg.sender]) revert OnlyAuthorizedReader();
        euint128 b = _balances[account];
        if (!Common.isInitialized(b)) {
            b = FHE.asEuint128(uint256(0));
            FHE.allowThis(b);
        }
        FHE.allow(b, msg.sender);
        return b;
    }

    /// @inheritdoc IMuHavenToken
    /// @dev Re-grants the caller ACL on `_encryptedTotalSupply` and returns
    ///      it. Pre-mint state maps to a fresh zero-handle. Quorum logic
    ///      upstream rejects zero supply explicitly.
    function getTotalSupplyForGovernance() external returns (euint128) {
        if (!authorizedReaders[msg.sender]) revert OnlyAuthorizedReader();
        euint128 ts = _encryptedTotalSupply;
        if (!Common.isInitialized(ts)) {
            ts = FHE.asEuint128(uint256(0));
            FHE.allowThis(ts);
        }
        FHE.allow(ts, msg.sender);
        return ts;
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
