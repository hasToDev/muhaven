// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, ebool} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IConditionResolver} from "../interfaces/IConditionResolver.sol";

/// @title TestCanRedeemChecker
/// @notice Test-only harness that invokes `IConditionResolver.canRedeem` and
///         persists the returned `ebool` into storage. Needed because
///         `canRedeem` is state-modifying (FHE ops), so `eth_call` /
///         `staticCall` cannot be used to inspect its return value — the
///         coprocessor state writes would be rolled back.
contract TestCanRedeemChecker {
    ebool public lastResult;

    function check(address resolver, uint256 escrowId) external {
        ebool r = IConditionResolver(resolver).canRedeem(escrowId);
        FHE.allowThis(r);
        lastResult = r;
    }
}
