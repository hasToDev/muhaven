// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, euint128, InEuint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IMuHavenToken} from "../interfaces/IMuHavenToken.sol";

/// @title MockSubscription
/// @notice Test-only bridge that converts a client-encrypted `InEuint128` into
///         a `euint128` handle and forwards it to MuHavenToken's paid-settlement
///         functions (`mintFromSubscription` / `burnFromSubscription`).
///
///         Real production path: `MuHavenSubscription.purchase/redeem` pulls
///         PUSDC, computes `FHE.mul(encShares, nav)`, then calls into
///         MuHavenToken. Phase 2 Subscription implementation lands next; this
///         mock exists so the MuHavenToken delta can be exercised in isolation.
///
///         The target MuHavenToken must register this contract via
///         `setSubscription(address(this))`.
contract MockSubscription {
    function mint(
        address token,
        address to,
        InEuint128 calldata input,
        address ephemeralEOA
    ) external {
        euint128 encAmount = FHE.asEuint128(input);
        FHE.allowThis(encAmount);
        FHE.allow(encAmount, token);
        IMuHavenToken(token).mintFromSubscription(to, encAmount, ephemeralEOA);
    }

    function burn(
        address token,
        address from,
        InEuint128 calldata input,
        address ephemeralEOA
    ) external {
        euint128 encAmount = FHE.asEuint128(input);
        FHE.allowThis(encAmount);
        FHE.allow(encAmount, token);
        IMuHavenToken(token).burnFromSubscription(from, encAmount, ephemeralEOA);
    }
}
