// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC165Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/introspection/ERC165Upgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {
    FHE,
    euint64,
    InEuint64,
    Common
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IFHERC20} from "./interfaces/IFHERC20.sol";
import {IInvestorRegistry} from "./interfaces/IInvestorRegistry.sol";
import {IMuHavenEscrow} from "./interfaces/IMuHavenEscrow.sol";
import {IYieldDistributor} from "./interfaces/IYieldDistributor.sol";

/// @title YieldDistributor
/// @notice Batched proportional yield distributor using PUSDC (ReineiraOS
///         confidential stablecoin). Issuers deposit yield via encrypted
///         `confidentialTransferFrom` — amounts are never visible on-chain.
///         Distribution is split into startDistribution() + processBatch()
///         to handle arbitrarily large investor sets without hitting block
///         gas limits.
///
///         Each investor's share is funded into a pre-created MuHavenEscrow
///         entry (via `IMuHavenEscrow.fundFrom`) gated by YieldGate. Escrow
///         IDs are created by the SDK via `muhavenEscrow.batchCreate` and
///         attached to the distribution via `setEscrowIds` before the first
///         batch runs.
///
///         Deployed behind an OZ Transparent Proxy.
///
/// @dev Privacy architecture:
///   - Yield is deposited as PUSDC (`euint64`) via the IFHERC20 operator model.
///     The issuer grants this contract operator status, then `startDistribution`
///     calls `confidentialTransferFrom` — no cleartext amounts are ever emitted.
///   - All yield handles stay as `euint64` (matches PUSDC's native width).
///     Previous `euint128` widening was removed — there is no RWA-balance
///     accounting in this contract, so the stablecoin width is authoritative.
///   - `FHE.allow(encAmount, muhavenEscrow)` grants the escrow ACL access so
///     it can run `FHE.add` inside `fundFrom`.
///   - `investorCount` remains cleartext (already public via InvestorRegistry).
///   - `_encTotalYieldDistributed` is encrypted — aggregate yield history private.
///
///   Known leakage:
///   - `DistributionStarted` emits `investorCount` (already public).
///   - `processedCount` and `escrowsCreated` are cleartext progress counters.
contract YieldDistributor is Initializable, ERC165Upgradeable, ReentrancyGuardTransient, IYieldDistributor {

    // ── Enums / structs ───────────────────────────────────────────────────

    enum DistributionStatus { PENDING, IN_PROGRESS, COMPLETED }

    struct Distribution {
        address token;
        euint64 encTotalYield;          // encrypted total yield deposited
        euint64 encPerInvestorYield;    // encrypted equal split: FHE.div(total, count)
        uint256 investorCount;          // snapshot at startDistribution time (public)
        uint256 processedCount;         // investors processed so far (public progress)
        uint256 escrowsCreated;         // escrows funded so far (public progress)
        DistributionStatus status;
    }

    // ── Storage ───────────────────────────────────────────────────────────

    /// @dev Distribution IDs start at 1. ID 0 is reserved / uninitialized.
    mapping(uint256 => Distribution) public distributions;
    uint256 public distributionCount;
    euint64 private _encTotalYieldDistributed;

    IInvestorRegistry public registry;
    IMuHavenEscrow public muhavenEscrow;
    address public yieldGate;
    address public owner;
    IFHERC20 public pusdc;

    /// @dev Issuers and AI agent addresses authorized to start distributions.
    mapping(address => bool) public authorizedCallers;

    /// @dev Informational only — not enforced on-chain in this version.
    uint256 public yieldIntervalSeconds;

    /// @dev SDK-provided MuHavenEscrow IDs, one per investor, aligned with
    ///      InvestorRegistry order at startDistribution time. Must be set
    ///      via setEscrowIds() before processBatch() runs.
    ///      Appended at the end of the storage block to preserve proxy layout.
    mapping(uint256 => uint256[]) private _distributionEscrowIds;

    /// @dev Reserved storage for future upgrades (proxy-safe gap).
    ///      Reduced from 50 → 49 when `_distributionEscrowIds` was added.
    uint256[49] private __gap;

    // ── Constants ─────────────────────────────────────────────────────────

    /// @dev Selector for confidentialTransferFrom(address,address,uint256).
    ///      The deployed ConfidentialUSDC uses cofhe-contracts < v0.1.0 where
    ///      euint64 wraps uint256. Our v0.1.3 uses bytes32, producing a different
    ///      selector. Pre-computed here to avoid runtime keccak256 on every call.
    bytes4 private constant _TRANSFER_FROM_UINT256 =
        bytes4(keccak256("confidentialTransferFrom(address,address,uint256)"));

    /// @dev Selector for confidentialTransfer(address,uint256). Same version-skew
    ///      rationale as _TRANSFER_FROM_UINT256. Used to push the total pulled
    ///      yield onward to MuHavenEscrow so redeem payouts have a cUSDC pool
    ///      to draw from (processBatch → fundFrom only tracks encrypted
    ///      accounting; it does NOT move tokens).
    bytes4 private constant _TRANSFER_UINT256 =
        bytes4(keccak256("confidentialTransfer(address,uint256)"));

    // ── Events ────────────────────────────────────────────────────────────

    event DistributionStarted(
        uint256 indexed distributionId,
        address indexed token,
        uint256 investorCount
    );
    event EscrowIdsAttached(uint256 indexed distributionId, uint256 count);
    event BatchProcessed(
        uint256 indexed distributionId,
        uint256 processedCount,
        uint256 investorCount
    );
    event DistributionCompleted(uint256 indexed distributionId);
    event YieldDecryptAccessGranted(uint256 indexed distributionId, address indexed viewer);
    event AuthorizedCallerUpdated(address indexed caller, bool authorized);
    event YieldGateUpdated(address indexed newGate);
    event MuHavenEscrowUpdated(address indexed newEscrow);
    event YieldScheduleUpdated(uint256 intervalSeconds);
    event PusdcUpdated(address indexed newPusdc);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ────────────────────────────────────────────────────────────

    error OnlyOwner();
    error Unauthorized();
    error NoInvestors();
    error AlreadyCompleted();
    error InvalidDistribution();
    error ZeroAddress();
    error PusdcTransferFailed();
    error EscrowIdsNotSet();
    error EscrowIdsAlreadySet();
    error EscrowIdsLengthMismatch();

    // ── Modifiers ─────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyAuthorized() {
        if (msg.sender != owner && !authorizedCallers[msg.sender]) revert Unauthorized();
        _;
    }

    // ── Initializer ───────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy. Called once by the deploy script.
    /// @param _registry       InvestorRegistry — source of investor list for batching
    /// @param _muhavenEscrow  MuHavenEscrow contract (or mock for testing)
    /// @param _yieldGate      YieldGate contract address used as escrow resolver
    /// @param _owner          Initial owner (deploy script / multisig)
    /// @param _pusdc          PUSDC (ConfidentialUSDC) address — IFHERC20 token used for yield
    function initialize(
        address _registry,
        address _muhavenEscrow,
        address _yieldGate,
        address _owner,
        address _pusdc
    ) external initializer {
        if (_registry == address(0) || _muhavenEscrow == address(0) ||
            _yieldGate == address(0) || _owner == address(0) ||
            _pusdc == address(0)) revert ZeroAddress();

        __ERC165_init();
        registry = IInvestorRegistry(_registry);
        muhavenEscrow = IMuHavenEscrow(_muhavenEscrow);
        yieldGate = _yieldGate;
        owner = _owner;
        pusdc = IFHERC20(_pusdc);
    }

    // ── Distribution: start ───────────────────────────────────────────────

    /// @notice Issuer or authorized agent deposits yield via PUSDC and initiates
    ///         a distribution. Pulls encrypted PUSDC from the caller using the
    ///         IFHERC20 operator model (`confidentialTransferFrom`).
    ///
    ///         The caller must have granted this contract operator status on PUSDC
    ///         via `pusdc.setOperator(address(this), expiry)` before calling.
    ///
    /// @param encryptedTotalYield  Client-encrypted yield amount in PUSDC.
    ///                             Caller encrypts via `Encryptable.uint64(amount)`
    ///                             and passes the InEuint64 struct (ctHash + proof).
    /// @return distributionId  Starts at 1
    function startDistribution(
        InEuint64 memory encryptedTotalYield
    ) external onlyAuthorized returns (uint256 distributionId) {
        uint256 count = registry.investorCount();
        if (count == 0) revert NoInvestors();

        // Convert client-encrypted input inside THIS contract (where msg.sender = EOA).
        // The signature is bound to msg.sender, so FHE.asEuint64 must run here,
        // not inside PUSDC (where msg.sender would be this contract).
        euint64 totalYield = FHE.asEuint64(encryptedTotalYield);

        // Grant PUSDC contract ACL access to the handle so it can perform
        // FHE operations (sub, add, select) inside _transfer / _update.
        // Pattern matches MockFherc20Vault from fhenix-confidential-contracts.
        FHE.allow(totalYield, address(pusdc));

        // The deployed ConfidentialUSDC was compiled with an older cofhe-contracts
        // where euint64 wraps uint256, producing selector confidentialTransferFrom(address,address,uint256).
        // Our cofhe-contracts v0.1.3 uses euint64=bytes32, producing a different selector.
        // Use a low-level call with the uint256 selector for compatibility.
        (bool ok, ) = address(pusdc).call(
            abi.encodeWithSelector(
                _TRANSFER_FROM_UINT256,
                msg.sender,
                address(this),
                uint256(euint64.unwrap(totalYield))
            )
        );
        if (!ok) revert PusdcTransferFailed();

        // Ensure persistent ACL for the division step below.
        FHE.allowThis(totalYield);

        // Push the whole pulled amount onward to MuHavenEscrow so redeem has
        // a cUSDC pool to draw from. fundFrom only updates the encrypted
        // per-investor counter — it does not move tokens.
        _forwardYieldToEscrow(totalYield);

        // Per-investor split stays in euint64 — matches PUSDC native width.
        euint64 encCount = FHE.asEuint64(count);
        FHE.allowThis(encCount);
        euint64 encPerInvestor = FHE.div(totalYield, encCount);
        FHE.allowThis(encPerInvestor);

        distributionId = ++distributionCount;
        distributions[distributionId] = Distribution({
            token:                address(pusdc),
            encTotalYield:        totalYield,
            encPerInvestorYield:  encPerInvestor,
            investorCount:        count,
            processedCount:       0,
            escrowsCreated:       0,
            status:               DistributionStatus.PENDING
        });

        emit DistributionStarted(distributionId, address(pusdc), count);
    }

    // ── Distribution: start from balance (two-step workaround) ──────────

    /// @notice Two-step workaround for when cross-contract confidentialTransferFrom
    ///         is unavailable (e.g., CoFHE testnet ACL limitation or selector mismatch).
    ///
    ///         Step 1: Issuer calls `pusdc.confidentialTransfer(address(this), inYield)`
    ///                 directly from their EOA — transfers PUSDC to this contract.
    ///                 This uses the InEuint64 overload which doesn't need cross-contract ACL.
    ///
    ///         Step 2: Issuer calls this function. It reads the contract's current PUSDC
    ///                 balance as the total yield and creates the distribution.
    ///
    ///         Trust assumption: the issuer deposited at least as much as the balance
    ///         reflects. Acceptable for hackathon; production would add verification.
    ///
    ///         Known limitation: uses the contract's entire PUSDC balance, which
    ///         could include undistributed funds from previous distributions.
    ///         Production: track per-distribution deposits or use a fresh escrow.
    ///
    /// @return distributionId  Starts at 1
    function startDistributionFromBalance()
        external onlyAuthorized returns (uint256 distributionId)
    {
        uint256 count = registry.investorCount();
        if (count == 0) revert NoInvestors();

        // Read our PUSDC balance — the FHERC20 _update function grants
        // FHE.allow(newBalance, address(this)) after each transfer to us,
        // so this contract has ACL access to the balance handle.
        euint64 totalYield = pusdc.confidentialBalanceOf(address(this));
        FHE.allowThis(totalYield);

        // Move the whole balance to MuHavenEscrow for redemption payouts.
        // Same rationale as `startDistribution`.
        _forwardYieldToEscrow(totalYield);

        euint64 encCount = FHE.asEuint64(count);
        FHE.allowThis(encCount);
        euint64 encPerInvestor = FHE.div(totalYield, encCount);
        FHE.allowThis(encPerInvestor);

        distributionId = ++distributionCount;
        distributions[distributionId] = Distribution({
            token:                address(pusdc),
            encTotalYield:        totalYield,
            encPerInvestorYield:  encPerInvestor,
            investorCount:        count,
            processedCount:       0,
            escrowsCreated:       0,
            status:               DistributionStatus.PENDING
        });

        emit DistributionStarted(distributionId, address(pusdc), count);
    }

    // ── Internal: PUSDC forwarding ───────────────────────────────────────

    /// @dev Push `amount` PUSDC from this contract to MuHavenEscrow. Low-level
    ///      call with the pre-v0.1.0 ConfidentialUSDC selector — same rationale
    ///      as the confidentialTransferFrom call in startDistribution.
    ///      Grants the payment token ACL access to the handle before the
    ///      transfer so its internal FHE.sub/add on balances succeeds.
    function _forwardYieldToEscrow(euint64 amount) internal {
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

    // ── Distribution: attach SDK-created escrows ─────────────────────────

    /// @notice Attach MuHavenEscrow IDs to a distribution. Called by the SDK
    ///         after `muhavenEscrow.batchCreate(encryptedOwners, ...)`.
    ///         The array MUST be aligned with the InvestorRegistry order used
    ///         to produce the encrypted owners — ids[i] is the escrow for
    ///         `registry.getInvestorsPaginated(i, 1)`.
    ///
    ///         One-shot: subsequent calls revert with EscrowIdsAlreadySet.
    /// @param distributionId  ID returned by startDistribution()
    /// @param escrowIds       One escrow ID per registered investor
    function setEscrowIds(
        uint256 distributionId,
        uint256[] calldata escrowIds
    ) external onlyAuthorized {
        if (distributionId == 0 || distributionId > distributionCount) revert InvalidDistribution();
        Distribution storage d = distributions[distributionId];
        if (escrowIds.length != d.investorCount) revert EscrowIdsLengthMismatch();
        if (_distributionEscrowIds[distributionId].length != 0) revert EscrowIdsAlreadySet();

        _distributionEscrowIds[distributionId] = escrowIds;
        emit EscrowIdsAttached(distributionId, escrowIds.length);
    }

    // ── Distribution: batch processing ───────────────────────────────────

    /// @notice Process the next batch of investors for a distribution.
    ///         Permissionless — anyone (issuer, agent, relayer) can call this.
    ///         Call repeatedly until isDistributionComplete() returns true.
    ///
    ///         FHE patterns applied:
    ///         - `encPerInvestorYield` handle is reused across investors in the batch.
    ///           For equal-split distributions sharing one handle is equivalent.
    ///         - `FHE.allow(encAmount, muhavenEscrow)` grants the escrow ACL access
    ///           so it can run `FHE.add` inside `fundFrom`.
    ///
    /// @param distributionId  ID returned by startDistribution()
    /// @param batchSize       Max investors to process in this call
    function processBatch(
        uint256 distributionId,
        uint256 batchSize
    ) external nonReentrant {
        if (distributionId == 0 || distributionId > distributionCount) revert InvalidDistribution();

        Distribution storage d = distributions[distributionId];
        if (d.status == DistributionStatus.COMPLETED) revert AlreadyCompleted();

        uint256[] storage ids = _distributionEscrowIds[distributionId];
        if (ids.length == 0) revert EscrowIdsNotSet();

        if (d.status == DistributionStatus.PENDING) {
            d.status = DistributionStatus.IN_PROGRESS;
        }

        uint256 remaining = d.investorCount - d.processedCount;
        uint256 actualBatch = batchSize < remaining ? batchSize : remaining;

        if (actualBatch > 0) {
            euint64 encAmount = d.encPerInvestorYield;
            uint256 startIndex = d.processedCount;

            // Grant escrow persistent ACL once per call — FHE.allow routes
            // through ITaskManager.allow (not allowTransient), so a single
            // grant covers every fundFrom in the loop.
            FHE.allow(encAmount, address(muhavenEscrow));

            for (uint256 i = 0; i < actualBatch; i++) {
                muhavenEscrow.fundFrom(ids[startIndex + i], encAmount);
                d.escrowsCreated++;
            }

            d.processedCount += actualBatch;
        }

        emit BatchProcessed(distributionId, d.processedCount, d.investorCount);

        if (d.processedCount >= d.investorCount) {
            d.status = DistributionStatus.COMPLETED;
            // Accumulate encrypted aggregate
            if (Common.isInitialized(_encTotalYieldDistributed)) {
                _encTotalYieldDistributed = FHE.add(_encTotalYieldDistributed, d.encTotalYield);
            } else {
                _encTotalYieldDistributed = d.encTotalYield;
            }
            FHE.allowThis(_encTotalYieldDistributed);
            emit DistributionCompleted(distributionId);
        }
    }

    // ── Views ─────────────────────────────────────────────────────────────

    function isDistributionComplete(uint256 distributionId) external view returns (bool) {
        return distributions[distributionId].status == DistributionStatus.COMPLETED;
    }

    /// @notice Returns cleartext metadata + encrypted yield handles for a distribution.
    ///         Encrypted fields are ciphertext handles — authorized callers decrypt
    ///         client-side via permits.
    function getDistribution(uint256 distributionId) external view returns (
        address token,
        euint64 encTotalYield,
        euint64 encPerInvestorYield,
        uint256 investorCount,
        uint256 processedCount,
        uint256 escrowsCreated,
        uint8 status
    ) {
        Distribution storage d = distributions[distributionId];
        return (
            d.token,
            d.encTotalYield,
            d.encPerInvestorYield,
            d.investorCount,
            d.processedCount,
            d.escrowsCreated,
            uint8(d.status)
        );
    }

    function getEscrowIds(uint256 distributionId) external view returns (uint256[] memory) {
        return _distributionEscrowIds[distributionId];
    }

    /// @notice Returns the encrypted aggregate of all completed distributions.
    function encryptedTotalYieldDistributed() external view returns (euint64) {
        return _encTotalYieldDistributed;
    }

    // ── Decrypt access ────────────────────────────────────────────────────

    /// @notice Grant `viewer` permit-based decrypt access to a distribution's
    ///         encrypted aggregates (`encTotalYield` and `encPerInvestorYield`).
    ///
    ///         The issuer who encrypted the input already has permit access via
    ///         CoFHE's per-input signature. This method extends access to a
    ///         third party (auditor, platform backend, regulator) without
    ///         exposing per-investor balances. Post-call, `viewer` can run
    ///         `cofheClient.decryptForView(ctHash).withPermit().execute()` on
    ///         both handles.
    ///
    ///         Idempotent — FHE.allow is safe to call repeatedly with the same
    ///         (handle, viewer) pair; the event fires each time for audit trail.
    ///
    /// @dev Uses plain `FHE.allow` only — never `createDecryptTask`. See
    ///      `feedback_fhe_decrypt_pattern` memory for the rationale.
    ///
    /// @param distributionId  ID returned by startDistribution()
    /// @param viewer          Address to grant decrypt-view access to
    function grantYieldDecryptAccess(uint256 distributionId, address viewer) external onlyOwner {
        if (viewer == address(0)) revert ZeroAddress();
        if (distributionId == 0 || distributionId > distributionCount) revert InvalidDistribution();

        Distribution storage d = distributions[distributionId];
        FHE.allow(d.encTotalYield, viewer);
        FHE.allow(d.encPerInvestorYield, viewer);

        emit YieldDecryptAccessGranted(distributionId, viewer);
    }

    // ── Admin ─────────────────────────────────────────────────────────────

    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        authorizedCallers[caller] = authorized;
        emit AuthorizedCallerUpdated(caller, authorized);
    }

    /// @notice Update the YieldGate address. Only affects future distributions.
    ///         Follows the swap pattern: deploy a new YieldGate and call this.
    function setYieldGate(address newGate) external onlyOwner {
        if (newGate == address(0)) revert ZeroAddress();
        yieldGate = newGate;
        emit YieldGateUpdated(newGate);
    }

    /// @notice Update the MuHavenEscrow contract. Only affects future batches.
    function setMuHavenEscrow(address newEscrow) external onlyOwner {
        if (newEscrow == address(0)) revert ZeroAddress();
        muhavenEscrow = IMuHavenEscrow(newEscrow);
        emit MuHavenEscrowUpdated(newEscrow);
    }

    /// @notice Set the minimum interval between distributions (informational).
    ///         Not enforced on-chain — consumed by the off-chain AI agent scheduler.
    function setYieldSchedule(uint256 intervalSeconds) external onlyOwner {
        yieldIntervalSeconds = intervalSeconds;
        emit YieldScheduleUpdated(intervalSeconds);
    }

    /// @notice Update the PUSDC (ConfidentialUSDC) address.
    function setPusdc(address newPusdc) external onlyOwner {
        if (newPusdc == address(0)) revert ZeroAddress();
        pusdc = IFHERC20(newPusdc);
        emit PusdcUpdated(newPusdc);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    // ── EIP-165 ─────────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override
        returns (bool)
    {
        return interfaceId == type(IYieldDistributor).interfaceId
            || super.supportsInterface(interfaceId);
    }
}
