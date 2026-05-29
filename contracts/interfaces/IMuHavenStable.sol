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

    /// @notice Phase 9.A · Option Z follow-up — `refreshAuditGrant` caller
    ///         lacks ACL on the supplied audit handle. Loud-revert so a
    ///         misconfigured frontend doesn't silently emit grant events for
    ///         handles the caller never owned.
    error NotAuditHandleOwner();

    // ── Direct USDC-exit errors (Wave 5 W3) ──────────────────────────────

    /// @notice `withdrawToUsdc` / `fundUsdcReserve` called before the owner
    ///         set the USDC reserve token via `setUsdcReserveToken`.
    error UsdcReserveNotSet();
    /// @notice `claimUsdc` ctHash has no matching pending claim (never
    ///         requested, or already claimed-and-pruned).
    error WithdrawClaimNotFound();
    /// @notice `claimUsdc` called before the coprocessor finished decrypting
    ///         the burned amount — retry after the decrypt delay.
    error WithdrawClaimNotReady();
    /// @notice `claimUsdc` ctHash was already settled.
    error WithdrawClaimAlreadyClaimed();
    /// @notice The contract's USDC reserve is below the claim amount. The
    ///         burn already happened; the claim stays pending — retry once
    ///         the owner tops up the reserve (`fundUsdcReserve`).
    error ReserveInsufficient();
    /// @notice `claimUsdc` is halted by the owner settlement kill-switch
    ///         (`setClaimsPaused(true)`) — separate from the wrap/transfer
    ///         `pause` so settlement can be frozen in a reserve emergency
    ///         without re-freezing deposits.
    error ClaimsPaused();
    /// @notice Caller already has `MAX_PENDING_WITHDRAWALS` unsettled
    ///         withdrawal claims. Settle (or wait for) existing ones before
    ///         requesting more — bounds the per-user claim list.
    error TooManyPendingWithdrawals();

    // ── Wave 5 W3 Phase 9 errors (direct wrap + stranded-PUSDC recovery) ──

    /// @notice A mutating amount argument was zero (`wrapUsdc` /
    ///         `recoverStrandedPusdcStart`). Loud-revert so a zero-value
    ///         no-op can't masquerade as a successful deposit/recovery.
    error ZeroAmount();
    /// @notice `wrapUsdc` was called with `amount > type(uint64).max`. mhUSDC
    ///         `_balances` is `euint64`; a larger inflow can't be represented
    ///         and silent truncation would create an undetectable accounting
    ///         bug, so we revert.
    error AmountOverflowsUint64();
    /// @notice `recoverStrandedPusdcStart` — the legacy PUSDC `unwrap` call
    ///         reverted or returned no claim id. The stranded PUSDC stays put;
    ///         re-check the legacy interface + the amount and retry.
    error RecoverFailed();
    /// @notice `recoverStrandedPusdcClaim` — the legacy PUSDC `claimUnwrapped`
    ///         call reverted (e.g. claim not ready, already claimed, or a wrong
    ///         claim id). No state change here; retry once the legacy decrypt
    ///         lands.
    error RecoverClaimFailed();
    /// @notice `setUsdcReserveToken` was given a token whose `decimals()` isn't
    ///         6 (or that doesn't implement `decimals()`). The 1:1 mhUSDC↔USDC
    ///         conversion (`wrapUsdc` mint + `claimUsdc` payout) requires a
    ///         6-dp reserve token; a mismatch would mint/pay at the wrong scale.
    error ReserveTokenDecimalsMismatch();

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
    /// @notice Phase 9.A · Option Z follow-up — emitted when a caller
    ///         re-grants ACL on a historical audit handle (Wrap/Unwrap event
    ///         amount) to a fresh ephemeralEOA. Lets the indexer surface "this
    ///         handle is freshly decryptable in the current session" without
    ///         having to chase TaskManager state.
    event AuditGrantRefreshed(address indexed owner, address indexed ephemeralEOA, euint64 handle);

    /// @notice Wave 5 W3 — a direct mhUSDC→USDC withdrawal was requested.
    ///         `claimId` keys the pending claim (`getWithdrawClaim`/`claimUsdc`);
    ///         `handle` is the burned euint64 ciphertext (clamp-bounded amount),
    ///         permit-decryptable by `account` / `ephemeralEOA` for audit.
    ///
    ///         NOTE: `claimId` (a per-contract monotonic counter), NOT `handle`,
    ///         is the claim key. CoFHE handles are content-addressed/deterministic
    ///         (a pure function of operand handles + opcode), so two identical
    ///         burns can share a `handle` — but each gets a distinct `claimId`
    ///         and is backed by its own burn, so each settles exactly once. Keying
    ///         by `handle` would silently drop the second burn (fund loss).
    event WithdrawRequested(
        address indexed account,
        address indexed ephemeralEOA,
        uint256 indexed claimId,
        bytes32 handle
    );
    /// @notice Wave 5 W3 — a pending withdrawal was settled: `amount` cleartext
    ///         USDC (6-dp) transferred to `account`. Amount is public here
    ///         because the USDC ERC-20 Transfer reveals it on-chain anyway.
    event WithdrawClaimed(address indexed account, uint256 indexed claimId, uint64 amount);
    /// @notice Wave 5 W3 — owner set/rotated the USDC reserve token.
    event UsdcReserveTokenSet(address indexed usdc);
    /// @notice Wave 5 W3 — owner funded the USDC reserve.
    event UsdcReserveFunded(address indexed from, uint256 amount);
    /// @notice Wave 5 W3 — owner recovered surplus USDC reserve.
    event UsdcReserveWithdrawn(address indexed to, uint256 amount);
    /// @notice Wave 5 W3 — owner toggled the settlement kill-switch.
    event ClaimsPausedSet(bool paused);

    // ── Wave 5 W3 Phase 9 events (direct wrap + stranded-PUSDC recovery) ──

    /// @notice A direct USDC → mhUSDC wrap landed. `amount` cleartext USDC
    ///         (public — the USDC ERC-20 Transfer reveals it anyway) entered
    ///         the reserve; `amountHandle` is the trivially-encrypted euint64
    ///         minted to `from` (permit-decryptable by `from` / `ephemeralEOA`).
    event WrapUsdc(
        address indexed from,
        address indexed ephemeralEOA,
        uint256 amount,
        euint64 amountHandle
    );
    /// @notice Owner initiated redemption of this contract's stranded legacy
    ///         PUSDC back into USDC (`recoverStrandedPusdcStart`). `legacyClaimId`
    ///         is the id returned by the legacy PUSDC — pass it to
    ///         `recoverStrandedPusdcClaim` to finalize.
    event StrandedPusdcRecoveryStarted(uint64 amount, uint256 indexed legacyClaimId);
    /// @notice Owner finalized a stranded-PUSDC recovery
    ///         (`recoverStrandedPusdcClaim`); the recovered USDC has landed in
    ///         this contract and auto-counts as `usdcReserveBalance()`.
    event StrandedPusdcRecoveryClaimed(uint256 indexed legacyClaimId);

    // ── Direct USDC-exit claim record (Wave 5 W3) ────────────────────────

    /// @notice A pending/settled mhUSDC→USDC withdrawal, keyed by a monotonic
    ///         `claimId`. `handle` is the burned euint64 ciphertext decrypted at
    ///         claim time. `amount` is 0 until claimed. `to == address(0)` ⇒
    ///         no such claim.
    struct WithdrawClaim {
        address to;
        bytes32 handle;
        uint64 amount;
        bool claimed;
    }

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

    /// @notice Wave 5 W3 Phase 9 — direct USDC → mhUSDC wrap. Pulls `amount`
    ///         cleartext USDC from the caller (must `usdc.approve(this, amount)`
    ///         first) straight into the reserve and mints `amount` of
    ///         trivially-encrypted mhUSDC. Collapses the legacy 2-step
    ///         (USDC → PUSDC → mhUSDC) to one tx and makes the reserve circular
    ///         — wraps grow it, withdraws drain it, no PUSDC accumulates.
    ///
    ///         Reverts `UsdcReserveNotSet` (reserve token unconfigured),
    ///         `ZeroAmount`, `AmountOverflowsUint64` (`amount > type(uint64).max`
    ///         — mhUSDC balances are euint64), `InvalidEphemeralEOA`, or
    ///         `PausedSurface` (wrapper-wide pause). The deposit amount is
    ///         public (the USDC Transfer log reveals it) — the same boundary as
    ///         the legacy 2-step wrap; mhUSDC balances/transfers/withdrawals
    ///         stay confidential.
    function wrapUsdc(uint256 amount, address ephemeralEOA) external;

    // ── Direct USDC exit (Wave 5 W3 — two-phase async, no PUSDC) ────────

    /// @notice Phase 1 of a direct mhUSDC→USDC withdrawal. Burns
    ///         `min(balance, encAmount)` mhUSDC from the caller (clamp to
    ///         balance — an over-request withdraws the full balance, not zero;
    ///         "withdraw all" via a large amount), then requests async
    ///         coprocessor decryption of the burned amount and records a
    ///         pending claim keyed by the burned ciphertext handle.
    ///         Settle later with `claimUsdc(claimId)`.
    ///
    ///         Unlike `unwrap` (which returns legacy PUSDC), this pays real
    ///         USDC from the contract's reserve at claim time — PUSDC never
    ///         enters the caller's path. Reverts `UsdcReserveNotSet` if the
    ///         owner hasn't configured the reserve token yet, or
    ///         `TooManyPendingWithdrawals` if the caller is at the per-user cap.
    /// @return claimId The monotonic id keying the new pending claim.
    function withdrawToUsdc(InEuint64 calldata encAmount, address ephemeralEOA)
        external
        returns (uint256 claimId);

    /// @notice Phase 2 of a direct withdrawal. Reads the coprocessor decrypt
    ///         result for the claim's stored handle; if ready, transfers that
    ///         many USDC (6-dp, 1:1 with mhUSDC) from the reserve to the claim's
    ///         recipient and marks it settled. Permissionless (pays the recorded
    ///         recipient, not the caller) so a backend auto-claim poller can
    ///         settle. Reverts `ClaimsPaused` (kill-switch),
    ///         `WithdrawClaimNotReady` (decrypt pending — retry),
    ///         `ReserveInsufficient` (claim stays pending — owner must top up),
    ///         `WithdrawClaimAlreadyClaimed`, or `WithdrawClaimNotFound`.
    function claimUsdc(uint256 claimId) external;

    /// @notice Owner-only — set/rotate the USDC reserve token. Must be called
    ///         post-upgrade before the first `withdrawToUsdc`. Rotating while
    ///         claims are pending is an owner footgun (claims are implicitly
    ///         1:1 in the token they were created against) — only safe with a
    ///         like-for-like 6-dp USDC or when no claims are pending.
    function setUsdcReserveToken(address usdc_) external;

    /// @notice Owner-only — fund the USDC reserve (pulls `amount` USDC from the
    ///         owner via `transferFrom`; owner must ERC-20-approve first).
    function fundUsdcReserve(uint256 amount) external;

    /// @notice Owner-only — recover surplus USDC reserve to `to`. The reserve
    ///         is owner-trusted: this can pull below outstanding burned-but-
    ///         unclaimed obligations, so the owner MUST keep the reserve funded
    ///         to cover all pending claims (see the W3 reserve-model ADR).
    function withdrawUsdcReserve(address to, uint256 amount) external;

    /// @notice Owner-only — toggle the settlement kill-switch. When true,
    ///         `claimUsdc` reverts `ClaimsPaused`. Separate from `pause` so the
    ///         owner can freeze USDC outflow in a reserve emergency without
    ///         re-freezing deposits/transfers.
    function setClaimsPaused(bool paused_) external;

    // ── Stranded-PUSDC recovery (Wave 5 W3 Phase 9 — owner-only) ─────────

    /// @notice Owner-only — initiate redemption of this contract's stranded
    ///         legacy PUSDC back into USDC. Every W3 withdraw leaves the PUSDC
    ///         that backed the burned mhUSDC stranded inside this contract;
    ///         this calls the legacy PUSDC's two-phase async `unwrap(this,
    ///         amount)` so the recovered USDC lands here on the claim leg and
    ///         auto-counts as `usdcReserveBalance()`. Finalize with
    ///         `recoverStrandedPusdcClaim(legacyClaimId)` after the legacy
    ///         coprocessor's decrypt delay (~30-60s).
    ///
    ///         `amount` is cleartext `uint64` — the owner must compute the
    ///         stranded total off-chain (= cumulative W3 burns − cumulative
    ///         unwraps); the contract can't decrypt its own confidential PUSDC
    ///         balance on-chain. Reverts `UsdcReserveNotSet`, `ZeroAmount`,
    ///         `OnlyOwner`, `PausedSurface`, or `RecoverFailed` (legacy call
    ///         reverted / returned no claim id).
    /// @return legacyClaimId The claim id returned by the legacy PUSDC — pass
    ///         it verbatim to `recoverStrandedPusdcClaim`.
    function recoverStrandedPusdcStart(uint64 amount) external returns (uint256 legacyClaimId);

    /// @notice Owner-only — finalize a started recovery by calling the legacy
    ///         PUSDC's `claimUnwrapped(legacyClaimId)`, so the recovered USDC
    ///         transfers into this contract. Reverts `OnlyOwner`,
    ///         `PausedSurface`, or `RecoverClaimFailed` (legacy claim not ready
    ///         / already claimed / wrong id).
    function recoverStrandedPusdcClaim(uint256 legacyClaimId) external;

    /// @notice Current USDC reserve balance held by the contract (0 if the
    ///         reserve token isn't set yet).
    function usdcReserveBalance() external view returns (uint256);

    /// @notice The pending/settled withdrawal claim for `claimId`
    ///         (`to == address(0)` ⇒ none).
    function getWithdrawClaim(uint256 claimId) external view returns (WithdrawClaim memory);

    /// @notice The caller-visible list of an account's pending claim ids
    ///         (settled claims are pruned from this list). Lets a returning
    ///         frontend re-discover in-flight withdrawals.
    function getUserWithdrawClaims(address account) external view returns (uint256[] memory);

    /// @notice Wraps `FHE.getDecryptResultSafe` for a withdrawal `claimId` so
    ///         the frontend can poll readiness without a client-side decrypt.
    ///         Returns (0,false) for an unknown claim.
    /// @return amount The decrypted USDC amount (meaningful only if `ready`).
    /// @return ready  Whether the coprocessor finished decrypting.
    function withdrawDecryptResult(uint256 claimId)
        external
        view
        returns (uint64 amount, bool ready);

    /// @notice The configured USDC reserve token (address(0) until set).
    function usdc() external view returns (address);

    /// @notice Whether the settlement kill-switch is engaged.
    function claimsPaused() external view returns (bool);

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

    /// @notice Re-grant FHE ACL on a HISTORICAL audit handle (the encrypted
    ///         amount carried in a `Wrap` / `Unwrap` event) to a fresh
    ///         `ephemeralEOA`. Required because each new ZeroDev session
    ///         mints a fresh ephemeral EOA — the wrap-time grant binds to
    ///         the session-of-origin only, so cross-session decrypt of the
    ///         /activity audit row 403s without an explicit rebind.
    ///
    ///         Authorisation: `FHE.isAllowed(handle, msg.sender)` must be
    ///         true. The wrap path stamped `FHE.allow(amount, msg.sender)`
    ///         for the kernel address, so the rightful owner naturally
    ///         passes this gate while strangers do not. No registry; the
    ///         on-chain ACL state IS the registry.
    ///
    ///         Distinct from `refreshDecryptGrant(eph)` which only refreshes
    ///         the live mhUSDC balance handle. This one operates on any
    ///         caller-owned handle (audit-row first; future yield-share or
    ///         redeem-proceeds rows could reuse the same surface).
    function refreshAuditGrant(euint64 handle, address ephemeralEOA) external;

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
