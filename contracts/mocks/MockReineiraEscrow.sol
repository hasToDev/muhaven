// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IReineiraEscrow} from "../interfaces/IReineiraEscrow.sol";

/// @title MockReineiraEscrow
/// @notice Test stand-in for the real ReineiraOS escrow contract.
///         Stores escrow data and issues sequential IDs; performs no
///         conditional settlement logic. Replace with real ReineiraOS
///         SDK integration in Wave 3.
///
///         NOT proxied — mocks are never upgraded in production.
contract MockReineiraEscrow is IReineiraEscrow {

    // ── Storage ───────────────────────────────────────────────────────────

    struct EscrowData {
        address beneficiary;
        euint128 amount;    // encrypted yield share (handle from CoFHE coprocessor)
        address gate;       // YieldGate address used as condition
    }

    /// @dev Escrow IDs start at 1. ID 0 is reserved / uninitialized.
    mapping(uint256 => EscrowData) private _escrows;
    uint256 public escrowCount;

    // ── Events ────────────────────────────────────────────────────────────

    event EscrowCreated(uint256 indexed escrowId, address indexed beneficiary, address indexed gate);

    // ── IReineiraEscrow ───────────────────────────────────────────────────

    /// @notice Create a new escrow record.
    /// @param beneficiary  Investor who will receive the yield on settlement
    /// @param amount       Encrypted yield amount (euint128 handle)
    /// @param gate         Condition gate contract (YieldGate)
    /// @return escrowId    Sequential ID starting at 1
    function create(
        address beneficiary,
        euint128 amount,
        address gate
    ) external returns (uint256 escrowId) {
        escrowId = ++escrowCount;
        _escrows[escrowId] = EscrowData({
            beneficiary: beneficiary,
            amount:      amount,
            gate:        gate
        });
        emit EscrowCreated(escrowId, beneficiary, gate);
    }

    /// @notice Retrieve escrow data by ID.
    function getEscrow(uint256 id) external view returns (
        address beneficiary,
        euint128 amount,
        address gate
    ) {
        EscrowData storage e = _escrows[id];
        return (e.beneficiary, e.amount, e.gate);
    }
}
