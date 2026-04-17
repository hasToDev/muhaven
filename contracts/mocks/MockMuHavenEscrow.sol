// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    FHE,
    eaddress,
    InEaddress,
    euint64,
    ebool,
    Common
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IMuHavenEscrow} from "../interfaces/IMuHavenEscrow.sol";
import {IConditionResolver} from "../interfaces/IConditionResolver.sol";

/// @title MockMuHavenEscrow
/// @notice Test stand-in for MuHavenEscrow. Mirrors the real contract's
///         creation + funding logic so tests can inspect stored state, but
///         omits the PUSDC transfer in redeem() to avoid requiring a payment
///         token setup for tests that only exercise the YieldDistributor path.
///
///         NOT proxied — mocks are never upgraded in production.
contract MockMuHavenEscrow is IMuHavenEscrow {

    // ── Storage ───────────────────────────────────────────────────────────

    struct Escrow {
        eaddress owner;
        euint64 paidAmount;
        ebool isRedeemed;
        address resolver;
        bool exists;
    }

    /// @dev Escrow IDs start at 1. ID 0 is reserved / uninitialized.
    mapping(uint256 => Escrow) private _escrows;
    uint256 public escrowCount;

    // ── IMuHavenEscrow ───────────────────────────────────────────────────

    /// @inheritdoc IMuHavenEscrow
    function batchCreate(
        InEaddress[] calldata owners,
        address resolver,
        bytes[] calldata resolverData
    ) external returns (uint256[] memory escrowIds) {
        if (resolver == address(0)) revert ZeroAddress();
        uint256 n = owners.length;
        if (n == 0) revert EmptyBatch();
        if (resolverData.length != n) revert LengthMismatch();

        escrowIds = new uint256[](n);

        for (uint256 i = 0; i < n; i++) {
            uint256 id = ++escrowCount;

            eaddress encOwner = FHE.asEaddress(owners[i]);
            FHE.allowThis(encOwner);

            Escrow storage e = _escrows[id];
            e.owner = encOwner;
            e.resolver = resolver;
            e.exists = true;

            IConditionResolver(resolver).onConditionSet(id, resolverData[i]);

            escrowIds[i] = id;
            emit EscrowCreated(id, resolver);
        }
    }

    /// @inheritdoc IMuHavenEscrow
    function fundFrom(uint256 escrowId, euint64 amount) external {
        Escrow storage e = _escrows[escrowId];
        if (!e.exists) revert EscrowDoesNotExist();

        if (Common.isInitialized(e.paidAmount)) {
            e.paidAmount = FHE.add(e.paidAmount, amount);
        } else {
            e.paidAmount = amount;
        }
        FHE.allowThis(e.paidAmount);

        emit EscrowFunded(escrowId);
    }

    /// @inheritdoc IMuHavenEscrow
    /// @dev Mock: marks redeemed without PUSDC transfer. Tests that need the
    ///      full redemption path should use the real MuHavenEscrow with MockPUSDC.
    function redeem(uint256 escrowId) external {
        Escrow storage e = _escrows[escrowId];
        if (!e.exists) revert EscrowDoesNotExist();

        ebool trueE = FHE.asEbool(true);
        FHE.allowThis(trueE);
        e.isRedeemed = trueE;

        emit EscrowRedeemed(escrowId);
    }

    /// @inheritdoc IMuHavenEscrow
    function redeemMultiple(uint256[] calldata escrowIds) external {
        uint256 n = escrowIds.length;
        if (n == 0) revert EmptyBatch();

        for (uint256 i = 0; i < n; i++) {
            uint256 id = escrowIds[i];
            Escrow storage e = _escrows[id];
            if (!e.exists) continue;

            ebool trueE = FHE.asEbool(true);
            FHE.allowThis(trueE);
            e.isRedeemed = trueE;

            emit EscrowRedeemed(id);
        }
    }

    // ── Views ─────────────────────────────────────────────────────────────

    function exists(uint256 escrowId) external view returns (bool) {
        return _escrows[escrowId].exists;
    }

    function getOwner(uint256 escrowId) external view returns (eaddress) {
        return _escrows[escrowId].owner;
    }

    function getPaidAmount(uint256 escrowId) external view returns (euint64) {
        return _escrows[escrowId].paidAmount;
    }

    function getIsRedeemed(uint256 escrowId) external view returns (ebool) {
        return _escrows[escrowId].isRedeemed;
    }

    function getResolver(uint256 escrowId) external view returns (address) {
        return _escrows[escrowId].resolver;
    }

    function total() external view returns (uint256) {
        return escrowCount;
    }
}
