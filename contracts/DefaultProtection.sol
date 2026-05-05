// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC165Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/introspection/ERC165Upgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {
    FHE,
    euint64,
    euint128,
    InEuint64,
    Common,
    ITaskManager,
    TASK_MANAGER_ADDRESS
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IFHERC20} from "./interfaces/IFHERC20.sol";
import {IInvestorRegistry} from "./interfaces/IInvestorRegistry.sol";
import {IMuHavenEscrow} from "./interfaces/IMuHavenEscrow.sol";
import {IDefaultProtection} from "./interfaces/IDefaultProtection.sol";

/// @title DefaultProtection
/// @notice Credit default protection module — issuer-funded first-loss reserve
///         with encrypted balance + equal-split payout to all investors of a
///         MuHavenToken via MuHavenEscrow.
///
///         Two-phase payout pipeline (mirrors `YieldDistributor`):
///           1. Owner / authorised trigger / issuer calls `triggerPayout(id)`.
///              Snapshots `investorCount`, computes `encPerInvestorPayout`
///              from the reserve, forwards the reserve PUSDC to MuHavenEscrow.
///           2. SDK creates one MuHavenEscrow per investor via `batchCreate`
///              (ZK-validated `InEaddress` owners), then attaches the IDs
///              to the protection via `setPayoutEscrowIds(id, ids)`.
///           3. Anyone calls `processPayoutBatch(id, batchSize)` repeatedly
///              until the distribution completes.
///
///         Deployed behind an OZ Transparent Proxy.
///
/// @dev Privacy architecture:
///   - PUSDC reserves are pulled via `confidentialTransferFrom`. The deployed
///     ConfidentialUSDC predates cofhe-contracts v0.1.0 so the function
///     selector uses `uint256` for the amount slot — same constant as
///     YieldDistributor / MuHavenEscrow (see `feedback_euint64_selector_mismatch`).
///   - The encrypted reserve balance is widened from `euint64` (PUSDC native)
///     to `euint128` for storage. Per-investor payout stays as `euint64` so
///     the handle composes directly with `MuHavenEscrow.fundFrom(uint256,euint64)`.
///   - `_encTotalReservesHeld` is the encrypted aggregate across all active
///     protections. Cleartext per-protection `reserveRateBps` is the trust
///     signal investors see; the actual reserve value stays encrypted.
///   - `triggerPayout` does NOT FHE-decrypt the reserve. It computes the
///     equal-split as `FHE.div(reserve, count)` directly on the encrypted
///     handle. The cleartext investor count comes from `InvestorRegistry`.
///   - On legacy testnet (cofhe-contracts < v0.1.0) the `requestReserveDecrypt`
///     async path may revert, mirroring the Wave 4 P0 finding documented in
///     `development/DEV_WAVE_4/ADR_LOG.md` ADR-1. Mock tests still cover it
///     so the contract surface stays compatible with the async-decrypt API
///     consumers expect; production callers should prefer the off-chain
///     `cofheClient.decryptForView(...).withPermit().execute()` path against
///     the handle returned by `getProtection`.
contract DefaultProtection is
    Initializable,
    ERC165Upgradeable,
    ReentrancyGuardTransient,
    IDefaultProtection
{

    // ── Enums / structs ──────────────────────────────────────────────

    /// @dev INACTIVE → ACTIVE → TRIGGERED → DISTRIBUTING → COMPLETED
    enum ProtectionStatus { INACTIVE, ACTIVE, TRIGGERED, DISTRIBUTING, COMPLETED }

    /// @dev Mirrors `YieldDistributor.DistributionStatus`.
    enum PayoutStatus { PENDING, IN_PROGRESS, COMPLETED }

    struct ProtectionConfig {
        address token;
        address issuer;
        uint256 reserveRateBps;
        euint128 encReserveBalance;
        ProtectionStatus status;
        uint256 createdAt;
        uint256 triggeredAt;
    }

    struct PayoutDistribution {
        euint64 encTotalPayout;
        euint64 encPerInvestorPayout;
        uint256 investorCount;
        uint256 processedCount;
        uint256 escrowsCreated;
        PayoutStatus status;
    }

    // ── Storage ──────────────────────────────────────────────────────

    /// @dev Protection IDs start at 1. ID 0 is reserved / uninitialised.
    mapping(uint256 => ProtectionConfig) private _protections;
    mapping(address => uint256) public tokenProtection;
    uint256 public protectionCount;
    uint256 public minimumReserveRateBps;

    mapping(uint256 => PayoutDistribution) private _payoutDistributions;
    mapping(uint256 => uint256[]) private _payoutEscrowIds;
    euint128 private _encTotalReservesHeld;

    IInvestorRegistry public registry;
    IMuHavenEscrow public muhavenEscrow;
    address public yieldGate;
    IFHERC20 public pusdc;

    address public owner;
    mapping(address => bool) public authorizedTriggers;

    /// @dev Reserved storage for future upgrades (proxy-safe gap).
    uint256[50] private __gap;

    // ── Constants ────────────────────────────────────────────────────

    /// @dev Hard upper bound on the reserve rate. 50% = 5000 bps.
    uint256 public constant MAX_RESERVE_RATE_BPS = 5000;

    /// @dev Selector for `confidentialTransferFrom(address,address,uint256)`.
    ///      See YieldDistributor for the version-skew rationale.
    bytes4 private constant _TRANSFER_FROM_UINT256 =
        bytes4(keccak256("confidentialTransferFrom(address,address,uint256)"));

    /// @dev Selector for `confidentialTransfer(address,uint256)`. Same skew.
    bytes4 private constant _TRANSFER_UINT256 =
        bytes4(keccak256("confidentialTransfer(address,uint256)"));

    // ── Modifiers ────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ── Initializer ──────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialise the proxy. Called once by the deploy script.
    /// @param _registry          InvestorRegistry — source of investor list
    /// @param _muhavenEscrow     Custom escrow used for batched payouts
    /// @param _yieldGate         IConditionResolver attached to created escrows
    /// @param _pusdc             PUSDC (ConfidentialUSDC) — IFHERC20 settlement token
    /// @param _owner             Initial owner / admin
    /// @param _minimumRateBps    Initial minimum reserve rate (e.g. 300 = 3%)
    function initialize(
        address _registry,
        address _muhavenEscrow,
        address _yieldGate,
        address _pusdc,
        address _owner,
        uint256 _minimumRateBps
    ) external initializer {
        if (
            _registry == address(0) ||
            _muhavenEscrow == address(0) ||
            _yieldGate == address(0) ||
            _pusdc == address(0) ||
            _owner == address(0)
        ) revert ZeroAddress();
        if (_minimumRateBps > MAX_RESERVE_RATE_BPS) revert RateAboveMaximum();

        __ERC165_init();
        registry = IInvestorRegistry(_registry);
        muhavenEscrow = IMuHavenEscrow(_muhavenEscrow);
        yieldGate = _yieldGate;
        pusdc = IFHERC20(_pusdc);
        owner = _owner;
        minimumReserveRateBps = _minimumRateBps;
    }

    // ── Issuer functions ─────────────────────────────────────────────

    /// @inheritdoc IDefaultProtection
    /// @dev Caller becomes the issuer-of-record for this protection. One
    ///      protection per token. The status starts INACTIVE; it flips to
    ///      ACTIVE on the first successful `depositReserve`.
    function createProtection(
        address token,
        uint256 reserveRateBps
    ) external returns (uint256 protectionId) {
        if (token == address(0)) revert ZeroAddress();
        if (reserveRateBps < minimumReserveRateBps) revert RateBelowMinimum();
        if (reserveRateBps > MAX_RESERVE_RATE_BPS) revert RateAboveMaximum();
        if (tokenProtection[token] != 0) revert ProtectionAlreadyExists();

        protectionId = ++protectionCount;
        ProtectionConfig storage p = _protections[protectionId];
        p.token = token;
        p.issuer = msg.sender;
        p.reserveRateBps = reserveRateBps;
        p.status = ProtectionStatus.INACTIVE;
        p.createdAt = block.timestamp;

        tokenProtection[token] = protectionId;

        emit ProtectionCreated(protectionId, token, msg.sender, reserveRateBps);
    }

    /// @inheritdoc IDefaultProtection
    function depositReserve(
        uint256 protectionId,
        InEuint64 memory encryptedAmount
    ) external nonReentrant {
        ProtectionConfig storage p = _resolveProtectionForIssuer(protectionId);
        if (
            p.status != ProtectionStatus.INACTIVE &&
            p.status != ProtectionStatus.ACTIVE
        ) revert ProtectionNotActive();

        // Convert client-encrypted PUSDC amount inside this contract — the
        // CoFHE input signature is bound to msg.sender.
        euint64 amount = FHE.asEuint64(encryptedAmount);
        FHE.allowThis(amount);

        _pullPusdc(amount);

        // Widen to euint128 for internal storage. Aggregating reserves across
        // multiple deposits / multiple protections in euint64 risks overflow
        // for very-active issuers; euint128 is the design floor.
        euint128 wide = FHE.asEuint128(amount);
        FHE.allowThis(wide);

        if (Common.isInitialized(p.encReserveBalance)) {
            p.encReserveBalance = FHE.add(p.encReserveBalance, wide);
        } else {
            p.encReserveBalance = wide;
        }
        FHE.allowThis(p.encReserveBalance);
        FHE.allow(p.encReserveBalance, p.issuer);

        _accumulateAggregate(wide);

        bool wasActive = p.status == ProtectionStatus.ACTIVE;
        if (!wasActive) {
            p.status = ProtectionStatus.ACTIVE;
            emit ReserveDeposited(protectionId, msg.sender);
        } else {
            emit ReserveTopUp(protectionId, msg.sender);
        }
    }

    /// @inheritdoc IDefaultProtection
    function topUpReserve(
        uint256 protectionId,
        InEuint64 memory encryptedAmount
    ) external nonReentrant {
        ProtectionConfig storage p = _resolveProtectionForIssuer(protectionId);
        if (p.status != ProtectionStatus.ACTIVE) revert ProtectionNotActive();

        euint64 amount = FHE.asEuint64(encryptedAmount);
        FHE.allowThis(amount);

        _pullPusdc(amount);

        euint128 wide = FHE.asEuint128(amount);
        FHE.allowThis(wide);

        p.encReserveBalance = FHE.add(p.encReserveBalance, wide);
        FHE.allowThis(p.encReserveBalance);
        FHE.allow(p.encReserveBalance, p.issuer);

        _accumulateAggregate(wide);

        emit ReserveTopUp(protectionId, msg.sender);
    }

    // ── Payout pipeline ──────────────────────────────────────────────

    /// @inheritdoc IDefaultProtection
    /// @dev Snapshots the cleartext investor count, computes per-investor
    ///      payout via `FHE.div`, and forwards the entire reserve PUSDC
    ///      balance to MuHavenEscrow as the payout pool. Mirrors the
    ///      `YieldDistributor.startDistribution` shape — `processPayoutBatch`
    ///      then attributes per-investor encrypted shares without moving
    ///      tokens further.
    ///
    ///      Note on `encReserveBalance` after trigger: the handle stored on
    ///      the protection is intentionally not zeroed. The status flip to
    ///      `TRIGGERED` freezes the protection (deposit / top-up paths
    ///      revert on `ProtectionNotActive`); the historical handle is
    ///      preserved for audit. Callers reading `getProtection(id)` after
    ///      a trigger should use `status` as the authoritative state, not
    ///      the balance handle.
    function triggerPayout(uint256 protectionId) external nonReentrant {
        if (protectionId == 0 || protectionId > protectionCount) revert InvalidProtection();
        ProtectionConfig storage p = _protections[protectionId];

        // Owner / authorised governance / issuer.
        if (
            msg.sender != owner &&
            !authorizedTriggers[msg.sender] &&
            msg.sender != p.issuer
        ) revert Unauthorized();

        if (p.status != ProtectionStatus.ACTIVE) revert ProtectionNotActive();

        uint256 count = registry.investorCount();
        if (count == 0) revert NoInvestors();

        // Forward the reserve to the escrow's PUSDC pool. We push the entire
        // contract-held balance of PUSDC because the per-protection reserve
        // is encrypted; transferring "the encrypted reserve amount" requires
        // a confidentialTransfer with that handle as the value, which we do
        // below.
        // Treat the encrypted reserve handle as the canonical payout total
        // — narrow to euint64 so it composes with PUSDC's native width and
        // with `MuHavenEscrow.fundFrom(uint256,euint64)`.
        euint64 totalNarrow = FHE.asEuint64(p.encReserveBalance);
        FHE.allowThis(totalNarrow);
        _forwardToEscrow(totalNarrow);

        euint64 encCount = FHE.asEuint64(count);
        FHE.allowThis(encCount);
        euint64 perInvestor = FHE.div(totalNarrow, encCount);
        FHE.allowThis(perInvestor);

        _payoutDistributions[protectionId] = PayoutDistribution({
            encTotalPayout:        totalNarrow,
            encPerInvestorPayout:  perInvestor,
            investorCount:         count,
            processedCount:        0,
            escrowsCreated:        0,
            status:                PayoutStatus.PENDING
        });

        p.status = ProtectionStatus.TRIGGERED;
        p.triggeredAt = block.timestamp;

        emit PayoutTriggered(protectionId, msg.sender, count);
    }

    /// @inheritdoc IDefaultProtection
    /// @dev One-shot — subsequent calls revert. The SDK encrypts investor
    ///      addresses off-chain and creates escrows via `batchCreate`; the
    ///      returned IDs are attached here in the order they will be funded.
    function setPayoutEscrowIds(
        uint256 protectionId,
        uint256[] calldata escrowIds
    ) external {
        if (protectionId == 0 || protectionId > protectionCount) revert InvalidProtection();
        ProtectionConfig storage p = _protections[protectionId];
        if (
            msg.sender != owner &&
            !authorizedTriggers[msg.sender] &&
            msg.sender != p.issuer
        ) revert Unauthorized();

        PayoutDistribution storage d = _payoutDistributions[protectionId];
        if (
            p.status != ProtectionStatus.TRIGGERED &&
            p.status != ProtectionStatus.DISTRIBUTING
        ) revert ProtectionNotTriggered();

        if (escrowIds.length != d.investorCount) revert EscrowIdsLengthMismatch();
        if (_payoutEscrowIds[protectionId].length != 0) revert EscrowIdsAlreadySet();

        _payoutEscrowIds[protectionId] = escrowIds;
        emit PayoutEscrowIdsAttached(protectionId, escrowIds.length);
    }

    /// @inheritdoc IDefaultProtection
    /// @dev Permissionless. Mirrors `YieldDistributor.processBatch`: re-grants
    ///      escrow ACL on the per-investor handle once per call, then loops
    ///      `fundFrom` over the next slice of escrow IDs.
    function processPayoutBatch(
        uint256 protectionId,
        uint256 batchSize
    ) external nonReentrant {
        if (protectionId == 0 || protectionId > protectionCount) revert InvalidProtection();
        PayoutDistribution storage d = _payoutDistributions[protectionId];
        if (d.status == PayoutStatus.COMPLETED) revert PayoutAlreadyCompleted();

        uint256[] storage ids = _payoutEscrowIds[protectionId];
        if (ids.length == 0) revert EscrowIdsNotSet();

        ProtectionConfig storage p = _protections[protectionId];

        if (d.status == PayoutStatus.PENDING) {
            d.status = PayoutStatus.IN_PROGRESS;
            p.status = ProtectionStatus.DISTRIBUTING;
        }

        uint256 remaining = d.investorCount - d.processedCount;
        uint256 actualBatch = batchSize < remaining ? batchSize : remaining;

        if (actualBatch > 0) {
            euint64 encAmount = d.encPerInvestorPayout;
            uint256 startIndex = d.processedCount;

            // Persistent ACL grant for the escrow contract — covers every
            // fundFrom call in this loop. Same pattern as YieldDistributor.
            FHE.allow(encAmount, address(muhavenEscrow));

            for (uint256 i = 0; i < actualBatch; i++) {
                muhavenEscrow.fundFrom(ids[startIndex + i], encAmount);
                d.escrowsCreated++;
            }

            d.processedCount += actualBatch;
        }

        emit PayoutBatchProcessed(protectionId, d.processedCount, d.investorCount);

        if (d.processedCount >= d.investorCount) {
            d.status = PayoutStatus.COMPLETED;
            p.status = ProtectionStatus.COMPLETED;
            emit PayoutCompleted(protectionId);
        }
    }

    // ── Async decrypt (issuer + owner only) ──────────────────────────

    /// @inheritdoc IDefaultProtection
    /// @dev Uses the legacy on-chain async-decrypt API so contracts and
    ///      explorers can read the cleartext value via
    ///      `getReserveDecryptResult` after the coprocessor delay. On Arb
    ///      Sepolia the per-protection issuer / owner can also use the
    ///      off-chain `cofheClient.decryptForView(handle).withPermit().execute()`
    ///      path against the handle returned by `getProtection` — that
    ///      avoids the deprecated on-chain decrypt-task entirely.
    function requestReserveDecrypt(uint256 protectionId) external {
        if (protectionId == 0 || protectionId > protectionCount) revert InvalidProtection();
        ProtectionConfig storage p = _protections[protectionId];
        if (msg.sender != owner && msg.sender != p.issuer) revert Unauthorized();
        if (!Common.isInitialized(p.encReserveBalance)) revert ProtectionNotActive();

        // Re-grant the requester so the off-chain alternative also works.
        FHE.allow(p.encReserveBalance, msg.sender);

        ITaskManager(TASK_MANAGER_ADDRESS).createDecryptTask(
            uint256(euint128.unwrap(p.encReserveBalance)),
            msg.sender
        );
        emit ReserveDecryptRequested(protectionId, msg.sender);
    }

    /// @inheritdoc IDefaultProtection
    function getReserveDecryptResult(uint256 protectionId)
        external
        view
        returns (uint64 reserveBalance, bool decrypted)
    {
        if (protectionId == 0 || protectionId > protectionCount) revert InvalidProtection();
        ProtectionConfig storage p = _protections[protectionId];
        if (!Common.isInitialized(p.encReserveBalance)) revert ProtectionNotActive();
        (uint128 wide, bool ready) = FHE.getDecryptResultSafe(p.encReserveBalance);
        // Cast back to uint64 — actual values stored are PUSDC-width-bounded.
        return (uint64(wide), ready);
    }

    // ── Views ────────────────────────────────────────────────────────

    /// @inheritdoc IDefaultProtection
    function getProtection(uint256 protectionId) external view returns (
        address token,
        address issuer,
        uint256 reserveRateBps,
        euint128 encReserveBalance,
        uint8 status,
        uint256 createdAt,
        uint256 triggeredAt
    ) {
        ProtectionConfig storage p = _protections[protectionId];
        return (
            p.token,
            p.issuer,
            p.reserveRateBps,
            p.encReserveBalance,
            uint8(p.status),
            p.createdAt,
            p.triggeredAt
        );
    }

    /// @inheritdoc IDefaultProtection
    function getPayoutDistribution(uint256 protectionId) external view returns (
        euint64 encTotalPayout,
        euint64 encPerInvestorPayout,
        uint256 investorCount,
        uint256 processedCount,
        uint256 escrowsCreated,
        uint8 status
    ) {
        PayoutDistribution storage d = _payoutDistributions[protectionId];
        return (
            d.encTotalPayout,
            d.encPerInvestorPayout,
            d.investorCount,
            d.processedCount,
            d.escrowsCreated,
            uint8(d.status)
        );
    }

    /// @inheritdoc IDefaultProtection
    function getPayoutEscrowIds(uint256 protectionId) external view returns (uint256[] memory) {
        return _payoutEscrowIds[protectionId];
    }

    /// @inheritdoc IDefaultProtection
    function isPayoutComplete(uint256 protectionId) external view returns (bool) {
        return _payoutDistributions[protectionId].status == PayoutStatus.COMPLETED;
    }

    /// @notice Returns the encrypted aggregate of all reserves accumulated
    ///         across protections (deposit + top-up). Owner-decryptable.
    function encryptedTotalReservesHeld() external view returns (euint128) {
        return _encTotalReservesHeld;
    }

    // ── Internal helpers ─────────────────────────────────────────────

    function _resolveProtectionForIssuer(uint256 protectionId)
        internal
        view
        returns (ProtectionConfig storage p)
    {
        if (protectionId == 0 || protectionId > protectionCount) revert InvalidProtection();
        p = _protections[protectionId];
        if (msg.sender != p.issuer) revert OnlyIssuer();
    }

    /// @dev Pull PUSDC from msg.sender into this contract via the
    ///      pre-v0.1.0 selector (matches deployed ConfidentialUSDC).
    function _pullPusdc(euint64 amount) internal {
        FHE.allow(amount, address(pusdc));
        (bool ok, ) = address(pusdc).call(
            abi.encodeWithSelector(
                _TRANSFER_FROM_UINT256,
                msg.sender,
                address(this),
                uint256(euint64.unwrap(amount))
            )
        );
        if (!ok) revert PusdcTransferFailed();
    }

    /// @dev Push the encrypted reserve to MuHavenEscrow as the payout pool.
    function _forwardToEscrow(euint64 amount) internal {
        FHE.allow(amount, address(pusdc));
        (bool ok, ) = address(pusdc).call(
            abi.encodeWithSelector(
                _TRANSFER_UINT256,
                address(muhavenEscrow),
                uint256(euint64.unwrap(amount))
            )
        );
        if (!ok) revert PusdcTransferFailed();
    }

    function _accumulateAggregate(euint128 delta) internal {
        if (Common.isInitialized(_encTotalReservesHeld)) {
            _encTotalReservesHeld = FHE.add(_encTotalReservesHeld, delta);
        } else {
            _encTotalReservesHeld = delta;
        }
        FHE.allowThis(_encTotalReservesHeld);
        FHE.allow(_encTotalReservesHeld, owner);
    }

    // ── Admin ────────────────────────────────────────────────────────

    /// @inheritdoc IDefaultProtection
    function setMinimumReserveRate(uint256 newMinBps) external onlyOwner {
        if (newMinBps > MAX_RESERVE_RATE_BPS) revert RateAboveMaximum();
        minimumReserveRateBps = newMinBps;
        emit MinimumReserveRateUpdated(newMinBps);
    }

    /// @inheritdoc IDefaultProtection
    function setAuthorizedTrigger(address trigger, bool authorized) external onlyOwner {
        if (trigger == address(0)) revert ZeroAddress();
        authorizedTriggers[trigger] = authorized;
        emit AuthorizedTriggerUpdated(trigger, authorized);
    }

    /// @inheritdoc IDefaultProtection
    function setMuHavenEscrow(address newEscrow) external onlyOwner {
        if (newEscrow == address(0)) revert ZeroAddress();
        muhavenEscrow = IMuHavenEscrow(newEscrow);
        emit MuHavenEscrowUpdated(newEscrow);
    }

    /// @inheritdoc IDefaultProtection
    function setYieldGate(address newGate) external onlyOwner {
        if (newGate == address(0)) revert ZeroAddress();
        yieldGate = newGate;
        emit YieldGateUpdated(newGate);
    }

    /// @inheritdoc IDefaultProtection
    function setPusdc(address newPusdc) external onlyOwner {
        if (newPusdc == address(0)) revert ZeroAddress();
        pusdc = IFHERC20(newPusdc);
        emit PusdcUpdated(newPusdc);
    }

    /// @inheritdoc IDefaultProtection
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    // ── EIP-165 ──────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override
        returns (bool)
    {
        return interfaceId == type(IDefaultProtection).interfaceId
            || super.supportsInterface(interfaceId);
    }
}
