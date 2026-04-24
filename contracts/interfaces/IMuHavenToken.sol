// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint128, InEuint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title IMuHavenToken
/// @notice External surface of MuHavenToken used by other contracts (Vault,
///         Subscription). Wave 3.5 adds `mintFromSubscription` +
///         `burnFromSubscription` per ADR-006 and ADR-021 (trailing
///         `ephemeralEOA` parameter).
interface IMuHavenToken {
    // ── Wave 3 path — kept for Vault + test/diagnostic scaffolding ──────
    function mint(address to, InEuint128 memory encryptedAmount) external;
    function mintFromVault(address to, uint256 amount) external;
    function burnFromVault(address from, uint256 amount) external;

    // ── Wave 3.5 path — paid settlement via MuHavenSubscription ─────────
    function mintFromSubscription(
        address to,
        euint128 encAmount,
        address ephemeralEOA
    ) external;
    /// @notice Burn `encAmount` shares from `from` on behalf of a paid redeem
    ///         executed through `MuHavenSubscription`. Returns the amount that
    ///         was actually burned: equal to `encAmount` if `from`'s balance
    ///         covers it, encrypted-zero otherwise (silent-fail per
    ///         `FHE_ACL_CONVENTIONS.md` Rule 5). The Subscription mirrors the
    ///         returned handle into the PUSDC payout leg so the investor only
    ///         receives proceeds for shares they actually held.
    function burnFromSubscription(
        address from,
        euint128 encAmount,
        address ephemeralEOA
    ) external returns (euint128 actualBurned);

    // ── Views / admin used by platform contracts ────────────────────────
    function encryptedBalanceOf(address account) external view returns (euint128);
    function encryptedTotalSupply() external view returns (euint128);
    function setTotalSupplyPublic() external;
    function totalSupplyPublic() external view returns (bool);
    function pause() external;
    function unpause() external;

    function subscription() external view returns (address);
    function setSubscription(address newSubscription) external;
}
