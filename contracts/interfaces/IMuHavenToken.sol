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

    // ── Wave 3.5 path — queued redemption via RedemptionQueue ───────────
    //
    // Three functions parallel the Subscription pattern. All are callable
    // only by the bound `queue` address (one-per-token). They skip the
    // standard compliance + KYC gates because the queue handles those at
    // its own entry points (submit / cancel own their compliance story),
    // and they return the silent-fail-bounded `actualPulled` / `actualBurned`
    // handle so the queue can mirror it into downstream math (same pattern
    // as `burnFromSubscription` per ADR-030).

    /// @notice Pull `encAmount` shares from `from` into the queue's balance.
    ///         Silent-fails to zero on insufficient balance per Rule 5.
    ///         Returns the actually-pulled handle so the queue can mirror it
    ///         into the request struct (ADR-036).
    function pullFromInvestor(
        address from,
        euint128 encAmount,
        address ephemeralEOA
    ) external returns (euint128 actualPulled);

    /// @notice Return `encAmount` shares from the queue's balance to `to`.
    ///         Used by `cancelOnKYCRevocation` per ADR-027. Skips compliance
    ///         (the investor is by construction KYC-revoked at the call
    ///         site — a compliance check would block every legitimate cancel).
    function returnToInvestor(
        address to,
        euint128 encAmount,
        address ephemeralEOA
    ) external;

    /// @notice Burn `encAmount` shares from the queue's own balance. Silent-
    ///         fails to zero on insufficient balance. Returns the actually-
    ///         burned handle for the queue's downstream math.
    function burnFromQueue(
        euint128 encAmount
    ) external returns (euint128 actualBurned);

    // ── Wave 3.5 Phase 5: YieldSnapshot ACL-grant reads ─────────────────
    //
    // `YieldSnapshot` needs read access on `_balances[investor]` and
    // `_encryptedTotalSupply` to run `FHE.mul` / `FHE.div` inside its
    // per-epoch claim math. The ACL on those handles is scoped to
    // MuHavenToken; without an explicit grant the downstream FHE op would
    // revert with ACL-denied. These helpers let the token re-grant the
    // caller (the wired `yieldSnapshot`) read access without exposing a
    // broader "grant any handle" surface. Callable only by the configured
    // `yieldSnapshot` address — set via `setYieldSnapshot`.

    /// @notice Re-grant the caller (`yieldSnapshot`) ACL on the investor's
    ///         current balance handle and return it. Fresh zero-handle for
    ///         never-held accounts so snapshot math always has a valid
    ///         input. Caller-gated to the wired `yieldSnapshot`.
    function snapshotBalance(address investor) external returns (euint128);

    /// @notice Re-grant the caller (`yieldSnapshot`) ACL on the encrypted
    ///         total supply handle and return it. Fresh zero-handle when
    ///         nothing has been minted yet. Caller-gated to the wired
    ///         `yieldSnapshot`.
    function snapshotTotalSupply() external returns (euint128);

    // ── Permit/decrypt refresh (ADR-021 + PERMIT_DECRYPT_LIFECYCLE §8 Q4) ─
    //
    // Self-service primitive: balance holder re-grants ACL on their own
    // current balance handle to a fresh ephemeral EOA. Closes the Phase 7
    // audit gap where a passive recipient / returning investor had no
    // path to bind decrypt rights to their new session's ephemeral EOA.

    function refreshDecryptGrant(address ephemeralEOA) external;

    // ── Views / admin used by platform contracts ────────────────────────
    function encryptedBalanceOf(address account) external view returns (euint128);
    function encryptedTotalSupply() external view returns (euint128);
    function setTotalSupplyPublic() external;
    function totalSupplyPublic() external view returns (bool);
    function pause() external;
    function unpause() external;

    function subscription() external view returns (address);
    function setSubscription(address newSubscription) external;

    function queue() external view returns (address);
    function setQueue(address newQueue) external;

    function yieldSnapshot() external view returns (address);
    function setYieldSnapshot(address newYieldSnapshot) external;

    function modularCompliance() external view returns (address);
}
