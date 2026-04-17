// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    eaddress,
    InEaddress,
    euint64,
    ebool
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title IMuHavenEscrow
/// @notice Custom FHE escrow that replaces ReineiraOS's ConfidentialEscrow.
///         Key properties:
///           - Owner stored as `eaddress` (ZK-validated via `InEaddress`).
///             Observers on-chain cannot link escrowId → investor.
///           - Two-phase funding: `batchCreate` records encrypted owners,
///             `fundFrom` accumulates encrypted PUSDC balance per escrow.
///           - Silent-failure redeem: wrong caller, unfunded escrow, or
///             failed resolver returns zero payout with identical gas cost.
///           - Resolver plugin (IConditionResolver) gates settlement; swap
///             without redeploying the escrow.
///
/// @dev Privacy stance: events emit only `escrowId` (no plaintext beneficiary).
///      The SDK registers escrowId → investor mappings off-chain with the
///      authenticated backend so pollers can track yield records without
///      placing the linkage on-chain.
interface IMuHavenEscrow {
    // ── Events ────────────────────────────────────────────────────────────

    event EscrowCreated(uint256 indexed escrowId, address indexed resolver);
    event EscrowFunded(uint256 indexed escrowId);
    event EscrowRedeemed(uint256 indexed escrowId);

    // ── Errors ────────────────────────────────────────────────────────────

    error ZeroAddress();
    error Unauthorized();
    error EscrowDoesNotExist();
    error LengthMismatch();
    error EmptyBatch();
    error BatchTooLarge();
    error ResolverCallbackFailed();
    error PaymentTokenNotSet();
    error PaymentTransferFailed();

    // ── Creation ──────────────────────────────────────────────────────────

    /// @notice Create a batch of escrows with ZK-validated encrypted owners.
    /// @param owners        Client-encrypted investor addresses (InEaddress).
    /// @param resolver      Condition resolver used by every escrow in the batch.
    /// @param resolverData  Per-escrow ABI-encoded resolver context (one entry per owner).
    /// @return escrowIds    Sequential IDs assigned to each new escrow.
    function batchCreate(
        InEaddress[] calldata owners,
        address resolver,
        bytes[] calldata resolverData
    ) external returns (uint256[] memory escrowIds);

    // ── Funding ───────────────────────────────────────────────────────────

    /// @notice Fund an existing escrow with an encrypted PUSDC amount (contract-to-contract handle).
    ///         Called by YieldDistributor.processBatch(). Caller must be authorized.
    ///         Accumulates into `paidAmount` via FHE.add — multiple fund calls allowed.
    /// @param escrowId  Target escrow.
    /// @param amount    Encrypted PUSDC amount (euint64 handle).
    function fundFrom(uint256 escrowId, euint64 amount) external;

    // ── Redemption ────────────────────────────────────────────────────────

    /// @notice Redeem a single escrow. Caller proves ownership client-side by
    ///         being `msg.sender`; the check runs on encrypted state and fails
    ///         silently (zero payout) if the caller is not the encrypted owner,
    ///         the escrow is already redeemed, or the resolver denies.
    /// @param escrowId  Escrow to redeem.
    function redeem(uint256 escrowId) external;

    /// @notice Redeem multiple escrows in one call. Runs the silent-failure
    ///         chain per escrow and aggregates a single PUSDC transfer.
    /// @param escrowIds  Escrows to redeem.
    function redeemMultiple(uint256[] calldata escrowIds) external;

    // ── Views ─────────────────────────────────────────────────────────────

    /// @notice True iff `escrowId` has been created.
    function exists(uint256 escrowId) external view returns (bool);

    /// @notice Encrypted owner handle. Decryptable only by the investor who
    ///         originally encrypted the address (or by holders of explicit FHE.allow).
    function getOwner(uint256 escrowId) external view returns (eaddress);

    /// @notice Encrypted running total of funds deposited into the escrow.
    function getPaidAmount(uint256 escrowId) external view returns (euint64);

    /// @notice Encrypted redemption flag (ebool).
    function getIsRedeemed(uint256 escrowId) external view returns (ebool);

    /// @notice Resolver address attached to the escrow.
    function getResolver(uint256 escrowId) external view returns (address);

    /// @notice Total escrows created so far (sequential, monotonically increasing).
    function total() external view returns (uint256);
}
