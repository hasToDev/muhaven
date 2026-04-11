// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC165Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/introspection/ERC165Upgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {
    FHE,
    euint64,
    InEuint64,
    euint128,
    Common,
    ITaskManager,
    TASK_MANAGER_ADDRESS
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IFHERC20} from "./interfaces/IFHERC20.sol";
import {IInvestorRegistry} from "./interfaces/IInvestorRegistry.sol";
import {IReineiraEscrow} from "./interfaces/IReineiraEscrow.sol";
import {IYieldDistributor} from "./interfaces/IYieldDistributor.sol";

/// @title YieldDistributor
/// @notice Batched proportional yield distributor using PUSDC (ReineiraOS
///         confidential stablecoin). Issuers deposit yield via encrypted
///         `confidentialTransferFrom` — amounts are never visible on-chain.
///         Distribution is split into startDistribution() + processBatch()
///         to handle arbitrarily large investor sets without hitting block
///         gas limits.
///
///         Each investor's share is encrypted and placed into a ReineiraOS escrow
///         with a YieldGate condition. In production, replace MockReineiraEscrow
///         and equal split with real ReineiraOS SDK + FHE proportional math.
///
///         Deployed behind an OZ Transparent Proxy.
///
/// @dev Privacy architecture:
///   - Yield is deposited as PUSDC (`euint64`) via the IFHERC20 operator model.
///     The issuer grants this contract operator status, then `startDistribution`
///     calls `confidentialTransferFrom` — no cleartext amounts are ever emitted.
///   - PUSDC amounts (`euint64`, 6 decimals) are widened to `euint128` via
///     `FHE.asEuint128(euint64)` for internal accounting consistency with
///     MuHavenToken balances (which use `euint128`).
///   - `FHE.allow(encAmount, investor)` grants each investor permit-based
///     decryption of their own yield share via client-side `decryptForView`.
///   - `investorCount` remains cleartext (already public via InvestorRegistry).
///   - `totalYieldDistributed` is encrypted — aggregate yield history is private.
///
///   Known leakage:
///   - `DistributionStarted` emits `investorCount` (already public).
///   - `processedCount` and `escrowsCreated` are cleartext progress counters.
contract YieldDistributor is Initializable, ERC165Upgradeable, ReentrancyGuardTransient, IYieldDistributor {

    // ── Enums / structs ───────────────────────────────────────────────────

    enum DistributionStatus { PENDING, IN_PROGRESS, COMPLETED }

    struct Distribution {
        address token;
        euint128 encTotalYield;         // encrypted total yield deposited
        euint128 encPerInvestorYield;   // encrypted equal split: FHE.div(total, count)
        uint256 investorCount;          // snapshot at startDistribution time (public)
        uint256 processedCount;         // investors processed so far (public progress)
        uint256 escrowsCreated;         // escrows successfully created (public progress)
        DistributionStatus status;
    }

    // ── Storage ───────────────────────────────────────────────────────────

    /// @dev Distribution IDs start at 1. ID 0 is reserved / uninitialized.
    mapping(uint256 => Distribution) public distributions;
    uint256 public distributionCount;
    euint128 private _encTotalYieldDistributed;

    IInvestorRegistry public registry;
    IReineiraEscrow public reineiraEscrow;
    address public yieldGate;
    address public owner;
    IFHERC20 public pusdc;

    /// @dev Issuers and AI agent addresses authorized to start distributions.
    mapping(address => bool) public authorizedCallers;

    /// @dev Informational only — not enforced on-chain in this version.
    uint256 public yieldIntervalSeconds;

    /// @dev Reserved storage for future upgrades (proxy-safe gap)
    uint256[50] private __gap;

    // ── Constants ─────────────────────────────────────────────────────────

    /// @dev Selector for confidentialTransferFrom(address,address,uint256).
    ///      The deployed ConfidentialUSDC uses cofhe-contracts < v0.1.0 where
    ///      euint64 wraps uint256. Our v0.1.3 uses bytes32, producing a different
    ///      selector. Pre-computed here to avoid runtime keccak256 on every call.
    bytes4 private constant _TRANSFER_FROM_UINT256 =
        bytes4(keccak256("confidentialTransferFrom(address,address,uint256)"));

    // ── Events ────────────────────────────────────────────────────────────

    event DistributionStarted(
        uint256 indexed distributionId,
        address indexed token,
        uint256 investorCount
    );
    event BatchProcessed(
        uint256 indexed distributionId,
        uint256 processedCount,
        uint256 investorCount
    );
    event DistributionCompleted(uint256 indexed distributionId);
    event AuthorizedCallerUpdated(address indexed caller, bool authorized);
    event YieldGateUpdated(address indexed newGate);
    event ReineiraEscrowUpdated(address indexed newEscrow);
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
    /// @param _reineiraEscrow ReineiraOS escrow contract (or mock for testing)
    /// @param _yieldGate      YieldGate contract address used as escrow condition
    /// @param _owner          Initial owner (deploy script / multisig)
    /// @param _pusdc          PUSDC (ConfidentialUSDC) address — IFHERC20 token used for yield
    function initialize(
        address _registry,
        address _reineiraEscrow,
        address _yieldGate,
        address _owner,
        address _pusdc
    ) external initializer {
        if (_registry == address(0) || _reineiraEscrow == address(0) ||
            _yieldGate == address(0) || _owner == address(0) ||
            _pusdc == address(0)) revert ZeroAddress();

        __ERC165_init();
        registry = IInvestorRegistry(_registry);
        reineiraEscrow = IReineiraEscrow(_reineiraEscrow);
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
    ///         PUSDC amounts are `euint64` (6-decimal stablecoin). These are widened
    ///         to `euint128` via `FHE.asEuint128(euint64)` for consistency with
    ///         MuHavenToken balances. The widening is lossless.
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

        // Ensure persistent ACL for the widening step below.
        // verifyInput granted transient access, but FHE.asEuint128 calls
        // TaskManager.cast which checks isAllowed. Persistent is safer
        // than relying on transient surviving across external calls.
        FHE.allowThis(totalYield);

        // Widen euint64 → euint128 for internal accounting consistency
        euint128 encTotal = FHE.asEuint128(totalYield);
        FHE.allowThis(encTotal);
        euint128 encCount = FHE.asEuint128(count);
        FHE.allowThis(encCount);
        euint128 encPerInvestor = FHE.div(encTotal, encCount);
        FHE.allowThis(encPerInvestor);

        distributionId = ++distributionCount;
        distributions[distributionId] = Distribution({
            token:                address(pusdc),
            encTotalYield:        encTotal,
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

        // Widen euint64 → euint128 for internal accounting consistency
        euint128 encTotal = FHE.asEuint128(totalYield);
        FHE.allowThis(encTotal);
        euint128 encCount = FHE.asEuint128(count);
        FHE.allowThis(encCount);
        euint128 encPerInvestor = FHE.div(encTotal, encCount);
        FHE.allowThis(encPerInvestor);

        distributionId = ++distributionCount;
        distributions[distributionId] = Distribution({
            token:                address(pusdc),
            encTotalYield:        encTotal,
            encPerInvestorYield:  encPerInvestor,
            investorCount:        count,
            processedCount:       0,
            escrowsCreated:       0,
            status:               DistributionStatus.PENDING
        });

        emit DistributionStarted(distributionId, address(pusdc), count);
    }

    // ── Distribution: batch processing ───────────────────────────────────

    /// @notice Process the next batch of investors for a distribution.
    ///         Permissionless — anyone (issuer, agent, relayer) can call this.
    ///         Call repeatedly until isDistributionComplete() returns true.
    ///
    ///         FHE patterns applied:
    ///         - `encPerInvestorYield` handle is reused across investors in the batch.
    ///           For equal-split distributions sharing one handle is equivalent.
    ///           Production upgrade: create a unique ciphertext per investor for unlinkability.
    ///         - `FHE.allow(encAmount, investor)` grants each investor permit-based
    ///           decryption of their own yield share via client-side `decryptForView`.
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

        if (d.status == DistributionStatus.PENDING) {
            d.status = DistributionStatus.IN_PROGRESS;
        }

        address[] memory investors = registry.getInvestorsPaginated(d.processedCount, batchSize);
        uint256 actualBatch = investors.length;

        if (actualBatch > 0) {
            euint128 encAmount = d.encPerInvestorYield;
            FHE.allow(encAmount, address(reineiraEscrow));

            for (uint256 i = 0; i < actualBatch; i++) {
                // Grant investor permit-based decryption of their yield share
                FHE.allow(encAmount, investors[i]);
                reineiraEscrow.create(investors[i], encAmount, yieldGate);
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
    ///         Encrypted fields (`encTotalYield`, `encPerInvestorYield`) are ciphertext
    ///         handles — authorized callers decrypt client-side via permits.
    function getDistribution(uint256 distributionId) external view returns (
        address token,
        euint128 encTotalYield,
        euint128 encPerInvestorYield,
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

    /// @notice Returns the encrypted aggregate of all completed distributions.
    function encryptedTotalYieldDistributed() external view returns (euint128) {
        return _encTotalYieldDistributed;
    }

    // ── Async decrypt for yield data ─────────────────────────────────────

    /// @notice Request async decryption of a distribution's yield amounts.
    ///         Only the owner or authorized callers can decrypt yield data.
    function requestYieldDecrypt(uint256 distributionId) external onlyAuthorized {
        if (distributionId == 0 || distributionId > distributionCount) revert InvalidDistribution();
        Distribution storage d = distributions[distributionId];

        FHE.allow(d.encTotalYield, msg.sender);
        FHE.allow(d.encPerInvestorYield, msg.sender);

        ITaskManager(TASK_MANAGER_ADDRESS).createDecryptTask(
            uint256(euint128.unwrap(d.encTotalYield)), msg.sender
        );
        ITaskManager(TASK_MANAGER_ADDRESS).createDecryptTask(
            uint256(euint128.unwrap(d.encPerInvestorYield)), msg.sender
        );
    }

    /// @notice Read async-decrypted yield amounts for a distribution.
    function getYieldDecryptResult(uint256 distributionId) external view returns (
        uint128 totalYield,
        bool totalYieldDecrypted,
        uint128 perInvestorYield,
        bool perInvestorYieldDecrypted
    ) {
        if (distributionId == 0 || distributionId > distributionCount) revert InvalidDistribution();
        Distribution storage d = distributions[distributionId];
        (totalYield, totalYieldDecrypted) = FHE.getDecryptResultSafe(d.encTotalYield);
        (perInvestorYield, perInvestorYieldDecrypted) = FHE.getDecryptResultSafe(d.encPerInvestorYield);
    }

    // ── Admin ─────────────────────────────────────────────────────────────

    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        authorizedCallers[caller] = authorized;
        emit AuthorizedCallerUpdated(caller, authorized);
    }

    /// @notice Update the YieldGate address. Only affects future distributions.
    ///         Follows the swap pattern: deploy a new YieldGate, then call this.
    function setYieldGate(address newGate) external onlyOwner {
        if (newGate == address(0)) revert ZeroAddress();
        yieldGate = newGate;
        emit YieldGateUpdated(newGate);
    }

    /// @notice Update the ReineiraOS escrow contract. Only affects future batches.
    function setReineiraEscrow(address newEscrow) external onlyOwner {
        if (newEscrow == address(0)) revert ZeroAddress();
        reineiraEscrow = IReineiraEscrow(newEscrow);
        emit ReineiraEscrowUpdated(newEscrow);
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
