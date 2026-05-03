// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {InEuint128, euint128, euint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title IYieldSnapshot
/// @notice Pull-based yield distribution per ADR-005. Replaces the Wave 3
///         push-based `YieldDistributor` + `MuHavenEscrow` pipeline.
///
/// @dev Lifecycle per epoch:
///      1. Issuer calls `openEpoch(token)` → new `epochId`.
///      2. Issuer calls `snapshotBatch(epochId, investors[])` in paginated
///         slices, capturing each investor's encrypted balance at the epoch
///         open time. Driven off `InvestorRegistry` (add-only per ADR-022).
///      3. Issuer calls `finalizeSnapshot(epochId)` to lock the snapshot and
///         read `encTotalSupply` from `MuHavenToken.encryptedTotalSupply`.
///      4. Issuer calls `fundEpoch(epochId, encTotalYield)` which pulls
///         PUSDC from the issuer (confidentialTransferFrom) and computes
///         `encRatio = FHE.div(encTotalYield, encTotalSupply)`.
///      5. Each investor calls `claimYield(epochId, ephemeralEOA)` — per-
///         investor payout is `FHE.mul(encBalance, encRatio)`. The handle is
///         `FHE.allow`-granted to `ephemeralEOA` (ADR-021).
///      6. After `claimExpiry`, issuer can `sweepExpired(epochId)` to reclaim
///         unclaimed PUSDC.
///
///      Conservation is guaranteed by the encrypted proportional math, not
///      by a runtime check. Double-claim reverts (not silent-fail) — double
///      claim is an operator/tooling bug, not a malicious side-channel.
interface IYieldSnapshot {
    // ── Types ─────────────────────────────────────────────────────────────

    struct Epoch {
        address  token;
        uint256  snapshotStartTs;
        uint256  snapshotEndTs;
        bool     finalized;
        bool     funded;
        euint128 encTotalYield;
        euint128 encTotalSupply;
        euint128 encRatio;          // = encTotalYield / encTotalSupply (legacy / Phase 9.A pre-Option-A; kept for backward-compat on pre-rev3 epochs)
        uint256  claimExpiry;
        uint256  holderCount;
        /// @notice Cleartext per-share yield rate (Phase 9.B / Option A,
        ///         2026-05-04). Issuer submits at `fundEpoch` time as the
        ///         floor-divide of `totalYield / totalSupply` in their own
        ///         off-chain ledger. claimYield's payout is
        ///         `encShare = FHE.mul(snapshotBalance,
        ///         FHE.asEuint128(uint256(ratePerShare)))` — the trivial-
        ///         encrypted cleartext rate has chain depth 1, so the
        ///         resulting `encShare` ancestry doesn't trace through the
        ///         deep `encRatio` accumulator that empirically stalls
        ///         cofhe TN's resolution. See `PHASE9A_CHAIN_LENGTH_BLOCKER.md`.
        ///
        ///         Privacy boundary: per-share rate is publicly observable
        ///         on-chain (storage slot is unencrypted). For RWAs this is
        ///         conventionally OK — yield rates are published off-chain
        ///         anyway (TBILL APY, dividend per share, etc). Per-investor
        ///         balances and per-investor shares stay encrypted.
        ///
        ///         Zero means "legacy epoch (pre-Option-A) — claim falls
        ///         back to the encRatio path." New epochs MUST set this
        ///         to a non-zero value.
        uint128  ratePerShare;
    }

    // ── Events ────────────────────────────────────────────────────────────

    event EpochOpened(address indexed token, uint256 indexed epochId);
    event SnapshotBatchApplied(uint256 indexed epochId, uint256 batchSize);
    event SnapshotFinalized(address indexed token, uint256 indexed epochId, uint256 holderCount);
    event EpochFunded(address indexed token, uint256 indexed epochId);
    /// @notice Emitted when an investor claims yield for an epoch.
    /// @param amount  Encrypted per-claim amount (euint64). Carries an
    ///                audit handle (kernel + ephemeralEOA grants) so the
    ///                investor can decrypt the per-claim amount via
    ///                `cofheClient.decryptForView` even when the cumulative
    ///                `MuHavenStable._balances[investor]` chain has grown
    ///                past the cofhe TN indexer threshold (~5-7 ops). The
    ///                audit handle's chain is short (`mul → cast` ≈ 2-3
    ///                ops) and indexer-friendly. See ADR-046 for the
    ///                wrapper-side bypass that this complements.
    event YieldClaimed(
        address indexed token,
        address indexed investor,
        uint256 indexed epochId,
        euint64 amount
    );
    event EpochExpired(address indexed token, uint256 indexed epochId);
    event IssuerUpdated(address indexed token, address indexed oldIssuer, address indexed newIssuer);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    /// @notice Emitted when a kernel re-stamps the audit-handle ACL grant
    ///         to a new ephemeralEOA. Mirrors `MuHavenStable.AuditGrantRefreshed`.
    event AuditGrantRefreshed(
        address indexed kernel,
        address indexed ephemeralEOA,
        euint64 handle
    );

    // ── Errors ────────────────────────────────────────────────────────────

    error OnlyOwner();
    error OnlyIssuer();
    error ZeroAddress();
    error InvalidEpoch();
    error SnapshotNotFinalized();
    error SnapshotAlreadyFinalized();
    error EpochAlreadyFunded();
    error EpochNotFunded();
    error NotYetExpired();
    error AlreadyClaimed();
    error InvalidEphemeralEOA();
    /// @notice `refreshAuditGrant` caller is not the rightful audit-handle
    ///         owner — they don't have an existing ACL grant on the handle
    ///         (i.e. they aren't the original claimer's kernel).
    error NotAuditHandleOwner();
    /// @notice Phase 9.B / Option A — `fundEpoch` rejected a zero
    ///         `ratePerShare`. Zero would silent-fail every claim
    ///         (mul-by-zero), stranding the funded PUSDC.
    error InvalidRatePerShare();

    // ── Issuer cold path ─────────────────────────────────────────────────

    /// @notice Open a new yield epoch for `token`. Issuer-only.
    /// @return epochId  Newly allocated epoch id.
    function openEpoch(address token) external returns (uint256 epochId);

    /// @notice Capture encrypted balances for a batch of investors into the
    ///         epoch's snapshot. Paginated — caller walks `InvestorRegistry`.
    function snapshotBatch(uint256 epochId, address[] calldata investors) external;

    /// @notice Finalize the snapshot: read and lock `encTotalSupply` from
    ///         `MuHavenToken`. Subsequent `snapshotBatch` calls revert.
    function finalizeSnapshot(uint256 epochId) external;

    /// @notice Pull `encTotalYield` PUSDC from the issuer and store the
    ///         issuer-provided per-share yield rate cleartext. Phase 9.B /
    ///         Option A (2026-05-04) — replaces the previous on-chain
    ///         `encRatio = FHE.div(encTotalYield, encTotalSupply)`
    ///         computation, which produced a deep handle ancestry that
    ///         empirically stalled cofhe TN's resolution path (see
    ///         `PHASE9A_CHAIN_LENGTH_BLOCKER.md`).
    ///
    ///         `ratePerShare` is computed by the issuer off-chain as
    ///         `floor(totalYieldCleartext / totalSupplyCleartext)`. It is
    ///         stored cleartext on the epoch struct. Per-share rate
    ///         disclosure is the privacy trade-off; per-investor balances
    ///         and per-claim shares stay encrypted.
    ///
    ///         Conservation guard: contract enforces
    ///         `ratePerShare > 0` (zero would silent-fail every claim,
    ///         leaving funded PUSDC stranded until sweep).
    ///
    ///         `claimExpiry` is set to
    ///         `block.timestamp + claimExpirySeconds` (implementation-
    ///         level per-token knob, not part of this interface).
    function fundEpoch(
        uint256 epochId,
        InEuint128 calldata encTotalYield,
        uint128 ratePerShare
    ) external;

    /// @notice Reclaim unclaimed PUSDC after `claimExpiry`. Issuer-only.
    function sweepExpired(uint256 epochId) external;

    // ── Investor hot path ────────────────────────────────────────────────

    /// @notice Claim the investor's proportional yield for a funded epoch.
    ///         Idempotent: re-calls revert with `AlreadyClaimed`.
    function claimYield(uint256 epochId, address ephemeralEOA) external;

    /// @notice Re-stamp the ACL grant on a previously-issued audit handle
    ///         (the `amount` field of a past `YieldClaimed` event) to a new
    ///         ephemeralEOA. Cross-session decrypt path — the originating
    ///         claim's eph is gone after a session rotation, but the
    ///         kernel that owned the claim still has a durable ACL grant
    ///         on the handle (granted at claim time via `FHE.allow(handle,
    ///         msg.sender)`). The auth gate is `FHE.isAllowed(handle,
    ///         msg.sender)` — strangers passing in someone else's audit
    ///         handle bounce with `NotAuditHandleOwner`. Mirrors
    ///         `MuHavenStable.refreshAuditGrant` (ADR-042).
    function refreshAuditGrant(euint64 handle, address ephemeralEOA) external;

    // ── Views ─────────────────────────────────────────────────────────────

    /// @notice Full epoch snapshot.
    function getEpoch(uint256 epochId) external view returns (Epoch memory);

    /// @notice Encrypted per-investor snapshot balance for an epoch.
    function getSnapshotBalance(uint256 epochId, address investor) external view returns (euint128);

    /// @notice Whether an investor has already claimed for an epoch.
    function hasClaimed(uint256 epochId, address investor) external view returns (bool);

    /// @notice Most recent epoch id opened for a token (0 if none).
    function currentEpoch(address token) external view returns (uint256);

    /// @notice Issuer address authorised to operate on `token`'s epochs.
    function issuer(address token) external view returns (address);
}
