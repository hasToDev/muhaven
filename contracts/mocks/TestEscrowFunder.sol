// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, euint64, InEuint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IMuHavenEscrow} from "../interfaces/IMuHavenEscrow.sol";

/// @title TestEscrowFunder
/// @notice Test-only bridge that converts a client-encrypted InEuint64 into a
///         euint64 handle and forwards it to `IMuHavenEscrow.fundFrom`.
///
///         Real production path: YieldDistributor.processBatch() calls fundFrom
///         with an on-chain-derived euint64 (encPerInvestorYield). Unit tests
///         want to fund escrows directly without wiring the full distributor,
///         so this contract fills that role.
///
///         The target escrow must add this contract as an authorized caller
///         via `escrow.setAuthorizedCaller(address(this), true)`.
contract TestEscrowFunder {
    function fundEscrow(
        address escrow,
        uint256 escrowId,
        InEuint64 calldata input
    ) external {
        euint64 amount = FHE.asEuint64(input);
        FHE.allowThis(amount);
        FHE.allow(amount, escrow);
        IMuHavenEscrow(escrow).fundFrom(escrowId, amount);
    }
}
