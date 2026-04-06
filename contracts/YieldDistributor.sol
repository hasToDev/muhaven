// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    FHE,
    euint128,
    Common
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IInvestorRegistry} from "./interfaces/IInvestorRegistry.sol";
import {IReineiraEscrow} from "./interfaces/IReineiraEscrow.sol";
import {IYieldDistributor} from "./interfaces/IYieldDistributor.sol";

/// @title YieldDistributor
/// @notice Batched proportional yield distributor. Issuers deposit a yield amount,
///         which is split equally among all registered investors. Distribution is
///         split into startDistribution() + processBatch() to handle arbitrarily
///         large investor sets without hitting block gas limits.
///
///         Each investor's share is encrypted and placed into a ReineiraOS escrow
///         with a YieldGate condition. In production, replace MockReineiraEscrow
///         and equal split with real ReineiraOS SDK + FHE proportional math.
///
///         Deployed behind an OZ Transparent Proxy.
contract YieldDistributor is Initializable, ReentrancyGuardTransient, IYieldDistributor {
    using SafeERC20 for IERC20;

    // ── Enums / structs ───────────────────────────────────────────────────

    enum DistributionStatus { PENDING, IN_PROGRESS, COMPLETED }

    struct Distribution {
        address token;
        uint256 totalYield;
        uint256 perInvestorYield;   // equal split: totalYield / investorCount
        uint256 investorCount;      // snapshot at startDistribution time
        uint256 processedCount;     // investors processed so far
        uint256 escrowsCreated;     // escrows successfully created
        DistributionStatus status;
    }

    // ── Storage ───────────────────────────────────────────────────────────

    /// @dev Distribution IDs start at 1. ID 0 is reserved / uninitialized.
    mapping(uint256 => Distribution) public distributions;
    uint256 public distributionCount;
    uint256 public totalYieldDistributed;

    IInvestorRegistry public registry;
    IReineiraEscrow public reineiraEscrow;
    address public yieldGate;
    address public owner;

    /// @dev Issuers and AI agent addresses authorized to start distributions.
    mapping(address => bool) public authorizedCallers;

    /// @dev Informational only — not enforced on-chain in this version.
    uint256 public yieldIntervalSeconds;

    /// @dev Reserved storage for future upgrades (proxy-safe gap)
    uint256[50] private __gap;

    // ── Events ────────────────────────────────────────────────────────────

    event DistributionStarted(
        uint256 indexed distributionId,
        address indexed token,
        uint256 totalYield,
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
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ────────────────────────────────────────────────────────────

    error OnlyOwner();
    error Unauthorized();
    error NoInvestors();
    error ZeroYield();
    error AlreadyCompleted();
    error InvalidDistribution();
    error ZeroAddress();

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
    function initialize(
        address _registry,
        address _reineiraEscrow,
        address _yieldGate,
        address _owner
    ) external initializer {
        if (_registry == address(0) || _reineiraEscrow == address(0) ||
            _yieldGate == address(0) || _owner == address(0)) revert ZeroAddress();

        registry = IInvestorRegistry(_registry);
        reineiraEscrow = IReineiraEscrow(_reineiraEscrow);
        yieldGate = _yieldGate;
        owner = _owner;
    }

    // ── Distribution: start ───────────────────────────────────────────────

    /// @notice Issuer or authorized agent deposits yield and initiates a distribution.
    ///         Transfers `totalYield` of `token` from the caller to this contract.
    ///         Snapshots the current investor count for batched processing.
    ///
    /// @param token       ERC-20 token used for yield (e.g. USDC)
    /// @param totalYield  Total amount to distribute, in token's smallest unit
    /// @return distributionId  Starts at 1
    function startDistribution(
        address token,
        uint256 totalYield
    ) external onlyAuthorized returns (uint256 distributionId) {
        if (totalYield == 0) revert ZeroYield();

        uint256 count = registry.investorCount();
        if (count == 0) revert NoInvestors();

        uint256 perInvestor = totalYield / count;

        IERC20(token).safeTransferFrom(msg.sender, address(this), totalYield);

        distributionId = ++distributionCount;
        distributions[distributionId] = Distribution({
            token:            token,
            totalYield:       totalYield,
            perInvestorYield: perInvestor,
            investorCount:    count,
            processedCount:   0,
            escrowsCreated:   0,
            status:           DistributionStatus.PENDING
        });

        emit DistributionStarted(distributionId, token, totalYield, count);
    }

    // ── Distribution: batch processing ───────────────────────────────────

    /// @notice Process the next batch of investors for a distribution.
    ///         Permissionless — anyone (issuer, agent, relayer) can call this.
    ///         Call repeatedly until isDistributionComplete() returns true.
    ///
    ///         FHE pattern: per-investor yield is encrypted once per batch call
    ///         and the handle is reused across all investors in that batch.
    ///         In production, each investor should get a unique ciphertext;
    ///         for equal-split distributions sharing one handle is equivalent.
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
            // Encrypt the per-investor yield amount once; handle reused across batch.
            // Production upgrade: create a unique ciphertext per investor for unlinkability.
            euint128 encAmount = FHE.asEuint128(d.perInvestorYield);
            FHE.allowThis(encAmount);
            FHE.allow(encAmount, address(reineiraEscrow));

            for (uint256 i = 0; i < actualBatch; i++) {
                reineiraEscrow.create(investors[i], encAmount, yieldGate);
                d.escrowsCreated++;
            }

            d.processedCount += actualBatch;
        }

        emit BatchProcessed(distributionId, d.processedCount, d.investorCount);

        if (d.processedCount >= d.investorCount) {
            d.status = DistributionStatus.COMPLETED;
            totalYieldDistributed += d.totalYield;
            emit DistributionCompleted(distributionId);
        }
    }

    // ── Views ─────────────────────────────────────────────────────────────

    function isDistributionComplete(uint256 distributionId) external view returns (bool) {
        return distributions[distributionId].status == DistributionStatus.COMPLETED;
    }

    function getDistribution(uint256 distributionId) external view returns (
        address token,
        uint256 totalYield,
        uint256 perInvestorYield,
        uint256 investorCount,
        uint256 processedCount,
        uint256 escrowsCreated,
        uint8 status
    ) {
        Distribution storage d = distributions[distributionId];
        return (
            d.token,
            d.totalYield,
            d.perInvestorYield,
            d.investorCount,
            d.processedCount,
            d.escrowsCreated,
            uint8(d.status)
        );
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

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }
}
