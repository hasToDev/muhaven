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

    /// @notice `trustedPayout` caller is not registered as a trusted payer.
    ///         Loud-revert (rather than silent-fail) so misconfigured
    ///         contract integrations surface the missing `setTrustedPayer`
    ///         pre-flight at the call site instead of silently falling
    ///         through to a zero-payout state.
    error NotTrustedPayer();

    // ── Events ───────────────────────────────────────────────────────────

    event StableInitialized(address indexed owner, address indexed legacyPusdc);
    /// @notice Phase 9.A · Option Z — broadened to carry the encrypted
    ///         amount handle so the wrap is auditable end-to-end. Decrypt
    ///         requires a permit grant against `account` or `ephemeralEOA`
    ///         (both are granted at the call site by `wrap` / `wrapHandle`).
    event Wrap(address indexed account, address indexed ephemeralEOA, euint64 amount);
    /// @notice Phase 9.A · Option Z — broadened to carry the silent-fail-
    ///         bounded `actual` amount handle (i.e. requested-or-balance,
    ///         whichever is smaller). Permit-decryptable by `account` or
    ///         `ephemeralEOA`.
    event Unwrap(address indexed account, address indexed ephemeralEOA, euint64 amount);
    event Transfer(address indexed from, address indexed to);
    event OperatorSet(address indexed holder, address indexed spender, uint48 until);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event LegacyPusdcUpdated(address indexed newPusdc);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event DecryptGrantRefreshed(address indexed holder, address indexed ephemeralEOA);
    event TrustedPayerSet(address indexed payer, bool allowed);

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

    /// @notice Modern-surface transferFrom with split per-leg `ephemeralEOA`
    ///         grants. Phase 7.6-E / ADR-044 — closes audit-prep §A-9 (the
    ///         Phase 7.6-D walkthrough finding): contract-mediated callers
    ///         (`MuHavenSubscription`, `RedemptionQueue`) need to grant the
    ///         investor's session decrypt access on ONLY their own leg of the
    ///         transfer. Pass `address(0)` for the counterparty leg to suppress
    ///         that leg's grant.
    ///
    ///         Direct EOA / P2P callers continue to use the 4-arg overload
    ///         which delegates here with `fromEph == toEph == ephemeralEOA`
    ///         (the original Phase 7.5-A both-leg behavior is preserved on the
    ///         legacy entrypoint).
    ///
    ///         Wrapper grants:
    ///           - `fromEph != address(0)` → `FHE.allow(_balances[from], fromEph)`
    ///           - `toEph != address(0)`   → `FHE.allow(_balances[to], toEph)`
    ///         Kernel grants on `from` / `to` always fire (matches legacy
    ///         PUSDC recipient-decrypt UX).
    function transferFrom(
        address from,
        address to,
        euint64 encAmount,
        address fromEph,
        address toEph
    ) external returns (euint64 actualTransferred);

    // ── Trusted-payer payout (Phase 8 Option B / ADR-046) ──────────────

    /// @notice Trusted-payer payout that skips `_silentFailBound`.
    ///         Cuts the wrapper-side FHE op chain from 5 ops (lte +
    ///         trivialEncrypt + select + sub + add) to 2 ops (sub + add).
    ///
    ///         For contract-mediated flows where conservation is
    ///         structurally guaranteed off-chain — currently
    ///         `YieldSnapshot.claimYield`, where `encShare =
    ///         floor(encBalance * encRatio)` and per-epoch conservation
    ///         (`sum(encShare) <= encTotalYield`) prevents the snapshot's
    ///         float from going negative across all legitimate claims.
    ///
    ///         Why exists: the cofhe Threshold Network's indexer on Arb
    ///         Sepolia testnet refused to index `_balances[investor]`
    ///         handles produced by the 8-op chain (`mul → cast → sub →
    ///         lte → trivialEncrypt → select → sub → add`) created by
    ///         `claimYield` + the wrapper's `_doTransfer`. Investors saw
    ///         indefinite `204` polls on `/v2/sealoutput`. Skipping
    ///         `_silentFailBound` reduces the chain to 5 ops and dodges
    ///         the indexer pathology. See `PHASE8_BLOCKER_YIELD_CLAIM_DECRYPT.md`.
    ///
    ///         ACL grants follow the split-grant pattern (ADR-044):
    ///         sender (caller) leg gets kernel-only; recipient (`to`) leg
    ///         gets `to`'s kernel + `ephemeralEOA`.
    ///
    ///         Restricted to `_trustedPayer[msg.sender] == true`. Loud-
    ///         reverts `NotTrustedPayer` for unauthorized callers.
    ///         FHE.sub underflows silently on insufficient sender balance —
    ///         the trusted caller is responsible for not over-spending.
    function trustedPayout(
        address to,
        euint64 encAmount,
        address ephemeralEOA
    ) external returns (euint64);

    function setTrustedPayer(address payer, bool allowed) external;
    function isTrustedPayer(address payer) external view returns (bool);

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
