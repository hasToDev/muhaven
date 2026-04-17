// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ebool} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title IConditionResolver
/// @notice Plugin interface for per-escrow settlement conditions.
///         Modelled after the ReineiraOS gate plugin system — lets MuHaven swap
///         condition logic (KYC, vesting, oracle checks) without touching the
///         core escrow contract.
///
/// @dev Two callbacks:
///      - `onConditionSet` is invoked during MuHavenEscrow.batchCreate() so the
///        resolver can cache any per-escrow data (e.g. beneficiary address used
///        for KYC lookup). The resolver MUST tolerate re-entry from the escrow.
///      - `canRedeem` is invoked inside MuHavenEscrow.redeem() and participates
///        in the encrypted AND chain that gates payout. Returning `ebool(false)`
///        causes silent failure (zero-amount payout, identical gas cost).
interface IConditionResolver {
    /// @notice Cache per-escrow context at creation time.
    /// @param escrowId  Sequential escrow ID.
    /// @param data      ABI-encoded condition payload (resolver-defined).
    function onConditionSet(uint256 escrowId, bytes calldata data) external;

    /// @notice Encrypted condition check evaluated inside redeem().
    ///         Must be side-channel-resistant: run identical code paths on
    ///         success and failure. Returns an `ebool` that is folded into
    ///         the escrow's `FHE.and` chain via `FHE.select`.
    /// @param escrowId  Sequential escrow ID.
    /// @return allowed  Encrypted boolean — true iff settlement is permitted.
    function canRedeem(uint256 escrowId) external returns (ebool allowed);
}
