// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint64, InEuint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title IMuHavenStable
/// @notice Confidential USDC wrapper owned by MuHaven. 1:1 collateralised
///         by the deployed pre-v0.1.0 ReineiraOS PUSDC ("legacy PUSDC")
///         that the wrapper holds in its own `confidentialBalanceOf` slot.
///
///         Replaces every Wave 3.5 use of PUSDC per Phase 7.5
///         (`MHUSD_WRAPPER_PLAN.md`). Lets the platform expose a modern
///         `euint64` ABI + ephemeralEOA-aware ACL grants per ADR-021,
///         neither of which the legacy PUSDC supports.
///
/// @dev Surface mirrors the IFHERC20 shape (so MuHavenStable can drop in
///      wherever PUSDC is referenced) and adds:
///        - Trailing `ephemeralEOA` parameter on every mutation per ADR-021
///          so investor decrypt works in the kernel + ephemeral-EOA model.
///        - `wrap` / `unwrap` to round-trip with legacy PUSDC.
///        - `refreshDecryptGrant(eph)` self-service ACL refresh that mirrors
///          `MuHavenToken.refreshDecryptGrant` (ADR-042).
///        - `pause` / `unpause` so the wrapper can be frozen if legacy PUSDC
///          depegs or the ReineiraOS contract is rugged.
///        - `setLegacyPusdc(addr)` for emergency rotation if ReineiraOS
///          redeploys PUSDC under cofhe-contracts ≥ v0.1.0.
///
///      The implementation also exposes the legacy
///      `confidentialTransfer(address,uint256)` /
///      `confidentialTransferFrom(address,address,uint256)` selectors as
///      additional public functions outside this interface — so existing
///      Wave 3.5 contracts calling PUSDC via the ADR-008 low-level path
///      keep working when their `pusdc` pointer rotates to MuHavenStable
///      without source-level edits.
interface IMuHavenStable {
    // ── Errors ───────────────────────────────────────────────────────────

    error OnlyOwner();
    error ZeroAddress();
    error InvalidEphemeralEOA();
    error NotOperator();
    error NoBalance();
    error WrapFailed();
    error UnwrapFailed();
    error UnauthorizedCaller();
    error AlreadyInitialized();

    // ── Events ───────────────────────────────────────────────────────────

    event StableInitialized(address indexed owner, address indexed legacyPusdc);
    event Wrap(address indexed account, address indexed ephemeralEOA);
    event Unwrap(address indexed account, address indexed ephemeralEOA);
    event Transfer(address indexed from, address indexed to);
    event OperatorSet(address indexed holder, address indexed spender, uint48 until);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event LegacyPusdcUpdated(address indexed newPusdc);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event DecryptGrantRefreshed(address indexed holder, address indexed ephemeralEOA);

    // ── Wrap / unwrap (1:1 legacy PUSDC ↔ mhUSDC) ──────────────────────

    /// @notice Pull `encAmount` legacy PUSDC from caller and mint equivalent
    ///         mhUSDC. Caller must first
    ///         `legacyPusdc.setOperator(mhUSDC, until)` — without operator
    ///         approval the underlying legacy PUSDC `confidentialTransferFrom`
    ///         reverts and `WrapFailed` propagates.
    function wrap(InEuint64 calldata encAmount, address ephemeralEOA) external;

    /// @notice Contract-mode wrap — pulls `amount` from `msg.sender` (must
    ///         already be a verified handle the caller holds ACL on) and
    ///         mints equivalent mhUSDC to `msg.sender`. Designed for
    ///         contract-to-contract wrapping (e.g.
    ///         `MuHavenTreasury.migrateToWrapper`).
    ///         `ephemeralEOA` may be `address(0)` for pure contract callers.
    function wrapHandle(euint64 amount, address ephemeralEOA) external;

    /// @notice Burn `encAmount` mhUSDC from caller, push equivalent legacy
    ///         PUSDC back. Silent-fails to zero on insufficient mhUSDC
    ///         balance per `FHE_ACL_CONVENTIONS.md` Rule 5 — observers
    ///         cannot distinguish a fully-funded unwrap from a truncated one.
    function unwrap(InEuint64 calldata encAmount, address ephemeralEOA) external;

    // ── Confidential transfers ─────────────────────────────────────────

    /// @notice Modern-surface transfer with EOA-encrypted input.
    function transfer(
        address to,
        InEuint64 calldata encAmount,
        address ephemeralEOA
    ) external returns (euint64 actualTransferred);

    /// @notice Modern-surface transfer with on-chain handle.
    function transfer(
        address to,
        euint64 encAmount,
        address ephemeralEOA
    ) external returns (euint64 actualTransferred);

    /// @notice Modern-surface transferFrom with EOA-encrypted input.
    ///         Caller must be operator on `from`.
    function transferFrom(
        address from,
        address to,
        InEuint64 calldata encAmount,
        address ephemeralEOA
    ) external returns (euint64 actualTransferred);

    /// @notice Modern-surface transferFrom with on-chain handle.
    function transferFrom(
        address from,
        address to,
        euint64 encAmount,
        address ephemeralEOA
    ) external returns (euint64 actualTransferred);

    // ── Operator model (mirrors legacy PUSDC) ──────────────────────────

    function setOperator(address operator, uint48 until) external;
    function isOperator(address holder, address spender) external view returns (bool);

    // ── Encrypted views ────────────────────────────────────────────────

    function confidentialBalanceOf(address account) external view returns (euint64);
    function confidentialTotalSupply() external view returns (euint64);

    // ── Self-service ACL refresh (mirrors MuHavenToken.refreshDecryptGrant) ─

    /// @notice Re-grant FHE ACL on the caller's own current mhUSDC balance
    ///         handle to `ephemeralEOA`. Closes the same Phase 7 audit gap
    ///         that ADR-042 closes for MuHavenToken — passive recipients
    ///         and returning users on fresh sessions can self-rebind decrypt
    ///         without an extra write op.
    function refreshDecryptGrant(address ephemeralEOA) external;

    // ── Admin ──────────────────────────────────────────────────────────

    /// @notice Pause wrap / unwrap / transfer / transferFrom. Burn-side
    ///         operations (`unwrap`) are blocked too — emergency halt is
    ///         the only intended use.
    function pause() external;

    function unpause() external;

    /// @notice Rotate the underlying legacy PUSDC pointer. Owner-only.
    ///         Intended for the path where ReineiraOS redeploys PUSDC under
    ///         cofhe-contracts ≥ v0.1.0; the wrapper would then sit between
    ///         that new PUSDC and the rest of the MuHaven stack.
    ///
    ///         Calling this MID-LIFE is *dangerous* — outstanding mhUSDC are
    ///         still backed by the OLD PUSDC. Only safe when total supply is
    ///         zero or the issuer is migrating in lockstep. Documented in
    ///         the Phase 7.5-D peg-break playbook.
    function setLegacyPusdc(address newPusdc) external;

    function transferOwnership(address newOwner) external;

    // ── State views ────────────────────────────────────────────────────

    function owner() external view returns (address);
    function legacyPusdc() external view returns (address);
    function paused() external view returns (bool);
}
