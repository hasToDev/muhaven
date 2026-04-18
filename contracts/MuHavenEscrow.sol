// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC165Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/introspection/ERC165Upgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {
    FHE,
    eaddress,
    InEaddress,
    euint64,
    ebool,
    Common
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IMuHavenEscrow} from "./interfaces/IMuHavenEscrow.sol";
import {IConditionResolver} from "./interfaces/IConditionResolver.sol";

/// @title MuHavenEscrow
/// @notice Custom FHE escrow for private yield settlement. Replaces
///         ReineiraOS's ConfidentialEscrow in MuHaven's yield pipeline.
///
///         Lifecycle:
///           1. SDK calls `batchCreate(InEaddress[], resolver, resolverData[])`
///              with client-encrypted investor addresses. Escrow IDs are assigned
///              sequentially and returned. The resolver's `onConditionSet` is
///              invoked for each escrow so it can cache per-escrow context
///              (e.g. beneficiary plaintext for KYC lookup).
///           2. YieldDistributor calls `fundFrom(escrowId, euint64 amount)` as
///              it iterates processBatch(). The contract accumulates paidAmount.
///           3. Investor (or an SDK relayer acting as them) calls `redeem(escrowId)`
///              or `redeemMultiple(ids)`. Ownership is enforced via a silent
///              encrypted AND chain — wrong caller, already-redeemed, unfunded,
///              or resolver-denied escrows produce zero payout with identical
///              gas cost. Successful redemption transfers encrypted PUSDC to
///              msg.sender.
///
///         Privacy stance:
///           - `owner` is stored as `eaddress` — observers cannot link escrowId
///             to investor at creation. Event emits only `escrowId`.
///           - `paidAmount` is `euint64` — yield share stays encrypted on-chain.
///           - Redeem leaks linkage via `msg.sender` (intrinsic) but not amount.
///
///         Payment currency is IFHERC20 (PUSDC on mainnet, MockPUSDC in tests).
///         PUSDC must be set via `setPaymentToken` before any `redeem` call.
///
///         Deployed behind an OZ Transparent Proxy.
contract MuHavenEscrow is Initializable, ERC165Upgradeable, ReentrancyGuardTransient, IMuHavenEscrow {

    // ── Storage ───────────────────────────────────────────────────────────

    struct Escrow {
        eaddress owner;       // ZK-validated investor address (encrypted)
        euint64 paidAmount;   // running sum of deposits (encrypted)
        ebool isRedeemed;     // encrypted redemption flag
        address resolver;     // condition resolver (plaintext)
        bool exists;          // plaintext existence flag
    }

    /// @dev Escrow IDs start at 1. ID 0 is reserved / uninitialized.
    mapping(uint256 => Escrow) private _escrows;
    uint256 public escrowCount;

    /// @dev PUSDC (ConfidentialUSDC) — paid out to investor on successful redeem.
    address public paymentToken;

    address public contractOwner;

    /// @dev Issuer, AI agent, and YieldDistributor addresses allowed to call
    ///      batchCreate + fundFrom. Redeem remains permissionless (silent-fail gates it).
    mapping(address => bool) public authorizedCallers;

    /// @dev Reserved storage for future upgrades (proxy-safe gap)
    uint256[50] private __gap;

    // ── Constants ─────────────────────────────────────────────────────────

    /// @dev Selector for confidentialTransfer(address,uint256) used on the
    ///      deployed ConfidentialUSDC (pre-v0.1.0 cofhe-contracts where
    ///      euint64 wraps uint256). Pre-computed to avoid keccak on every call.
    ///      See PUSDC_TRANSFER_ISSUE.md for the selector mismatch analysis.
    bytes4 private constant _TRANSFER_UINT256 =
        bytes4(keccak256("confidentialTransfer(address,uint256)"));

    /// @dev Hard upper bound on arrays accepted by batchCreate / redeemMultiple.
    ///      Prevents OOG by callers passing pathological inputs and documents the
    ///      SDK's expected paging behavior (plan 19C batches at 50; 200 is a
    ///      comfortable headroom). Enforce explicitly so reverts surface a named
    ///      error rather than a raw OOG / 0x panic.
    ///
    ///      **Practical ceiling is gas-bound, not constant-bound.** Each escrow
    ///      in `batchCreate` runs `FHE.asEaddress` (ZK validation ≈ 300–500k gas)
    ///      plus a resolver callback; each escrow in `redeemMultiple` runs the
    ///      silent-failure AND chain (3 FHE.eq/and/not + FHE.select ≈ 1M+ gas).
    ///      On Arb Sepolia (30M block gas limit), realistic ceilings are around
    ///      50 for batchCreate and 20–30 for redeemMultiple. The SDK defaults to
    ///      batchSize=50 to stay comfortably inside these bounds. Callers passing
    ///      values above the practical ceiling will hit OOG before `BatchTooLarge`.
    uint256 public constant MAX_BATCH_SIZE = 200;

    // ── Events (extra) ───────────────────────────────────────────────────

    event AuthorizedCallerUpdated(address indexed caller, bool authorized);
    event PaymentTokenUpdated(address indexed newToken);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Modifiers ─────────────────────────────────────────────────────────

    modifier onlyContractOwner() {
        if (msg.sender != contractOwner) revert Unauthorized();
        _;
    }

    modifier onlyAuthorized() {
        if (msg.sender != contractOwner && !authorizedCallers[msg.sender]) revert Unauthorized();
        _;
    }

    // ── Initializer ───────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy. Called once by the deploy script.
    /// @param _owner         Initial contract owner / admin.
    /// @param _paymentToken  PUSDC address (IFHERC20). May be zero and set later.
    function initialize(address _owner, address _paymentToken) external initializer {
        if (_owner == address(0)) revert ZeroAddress();
        __ERC165_init();
        contractOwner = _owner;
        paymentToken = _paymentToken;
    }

    // ── Creation ──────────────────────────────────────────────────────────

    /// @inheritdoc IMuHavenEscrow
    function batchCreate(
        InEaddress[] calldata owners,
        address resolver,
        bytes[] calldata resolverData
    ) external onlyAuthorized returns (uint256[] memory escrowIds) {
        if (resolver == address(0)) revert ZeroAddress();
        uint256 n = owners.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH_SIZE) revert BatchTooLarge();
        if (resolverData.length != n) revert LengthMismatch();

        escrowIds = new uint256[](n);

        for (uint256 i = 0; i < n; i++) {
            uint256 id = ++escrowCount;

            // ZK-validate client-encrypted owner address.
            eaddress encOwner = FHE.asEaddress(owners[i]);
            FHE.allowThis(encOwner);

            Escrow storage e = _escrows[id];
            e.owner = encOwner;
            e.resolver = resolver;
            e.exists = true;
            // paidAmount + isRedeemed stay uninitialized; treated as zero/false
            // by the redeem path via Common.isInitialized checks.

            // Notify resolver so it can cache per-escrow plaintext context.
            try IConditionResolver(resolver).onConditionSet(id, resolverData[i]) {
                // ok
            } catch {
                revert ResolverCallbackFailed();
            }

            escrowIds[i] = id;
            emit EscrowCreated(id, resolver);
        }
    }

    // ── Funding ───────────────────────────────────────────────────────────

    /// @inheritdoc IMuHavenEscrow
    function fundFrom(uint256 escrowId, euint64 amount) external onlyAuthorized {
        Escrow storage e = _escrows[escrowId];
        if (!e.exists) revert EscrowDoesNotExist();

        if (Common.isInitialized(e.paidAmount)) {
            e.paidAmount = FHE.add(e.paidAmount, amount);
        } else {
            e.paidAmount = amount;
        }
        FHE.allowThis(e.paidAmount);

        emit EscrowFunded(escrowId);
    }

    // ── Redemption ────────────────────────────────────────────────────────

    /// @inheritdoc IMuHavenEscrow
    ///
    /// @dev Silent-failure chain — every branch runs identical FHE ops so
    ///      observers cannot distinguish success from failure by gas cost.
    ///
    ///      canRedeem = owner == msg.sender
    ///               AND NOT isRedeemed
    ///               AND resolver.canRedeem(id)
    ///
    ///      paidAmount is implicitly gated: unfunded escrows fall through
    ///      to a trivial encrypted-zero payout via the uninitialized-handle check.
    ///
    ///      Semantics worth knowing for integrators:
    ///      - `EscrowRedeemed(escrowId)` is emitted UNCONDITIONALLY — even when
    ///        the encrypted canRedeem check yields false (attacker-initiated
    ///        silent-fail calls still emit). Off-chain pollers MUST verify the
    ///        resulting `isRedeemed` ciphertext (or observe PUSDC movement)
    ///        before marking a yield record as claimed. Emitting conditionally
    ///        would leak the silent-fail outcome through event presence.
    ///      - Reverts with `EscrowDoesNotExist` on unknown escrowIds. This is
    ///        intentional asymmetry with `redeemMultiple` (see below): single
    ///        redeem surfaces caller bugs loudly, while batch redeem silently
    ///        skips unknown IDs so one bad ID doesn't abort a whole claim.
    function redeem(uint256 escrowId) external nonReentrant {
        if (paymentToken == address(0)) revert PaymentTokenNotSet();

        (euint64 payout, ebool canRedeem) = _computePayout(escrowId);

        // Flip isRedeemed only when canRedeem is encrypted-true.
        _markRedeemed(escrowId, canRedeem);

        // Send payout — zero-amount transfers succeed and are indistinguishable
        // from funded redemptions on-chain.
        _pay(msg.sender, payout);

        emit EscrowRedeemed(escrowId);
    }

    /// @inheritdoc IMuHavenEscrow
    ///
    /// @dev Runs the silent-failure chain per escrow, accumulates an encrypted
    ///      euint64 payout, then performs a single PUSDC transfer. Non-existent
    ///      IDs skip plaintext-silently (existence is already public state) —
    ///      intentional asymmetry with `redeem()` so a single bad ID doesn't
    ///      abort a bulk claim. Per-escrow `EscrowRedeemed` events fire for
    ///      every processed (existing) ID regardless of canRedeem outcome —
    ///      see the note on `redeem()` above.
    function redeemMultiple(uint256[] calldata escrowIds) external nonReentrant {
        if (paymentToken == address(0)) revert PaymentTokenNotSet();
        uint256 n = escrowIds.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH_SIZE) revert BatchTooLarge();

        euint64 accumulated;
        bool accumulatedInit;

        for (uint256 i = 0; i < n; i++) {
            uint256 id = escrowIds[i];
            if (!_escrows[id].exists) continue;

            (euint64 payout, ebool canRedeem) = _computePayout(id);
            _markRedeemed(id, canRedeem);

            if (accumulatedInit) {
                accumulated = FHE.add(accumulated, payout);
            } else {
                accumulated = payout;
                accumulatedInit = true;
            }
            FHE.allowThis(accumulated);

            emit EscrowRedeemed(id);
        }

        if (accumulatedInit) {
            _pay(msg.sender, accumulated);
        }
    }

    // ── Internal redeem helpers ───────────────────────────────────────────

    /// @dev Returns (payout, canRedeem) for an existing escrow. Reverts if the
    ///      escrow does not exist — called only from paths that verified existence.
    function _computePayout(uint256 id) internal returns (euint64 payout, ebool canRedeem) {
        Escrow storage e = _escrows[id];
        if (!e.exists) revert EscrowDoesNotExist();

        // Callers's encrypted address — trivially encrypt the plaintext msg.sender.
        eaddress callerEa = FHE.asEaddress(msg.sender);
        FHE.allowThis(callerEa);

        // (1) owner == msg.sender
        ebool ownerOk = FHE.eq(e.owner, callerEa);
        FHE.allowThis(ownerOk);

        // (2) NOT isRedeemed — treat uninitialized as false (i.e. NOT false == true).
        ebool notRedeemed;
        if (Common.isInitialized(e.isRedeemed)) {
            notRedeemed = FHE.not(e.isRedeemed);
        } else {
            notRedeemed = FHE.asEbool(true);
        }
        FHE.allowThis(notRedeemed);

        // (3) resolver gate — grant resolver access to any state it needs via
        //     its own allowances; we just call and fold the ebool result.
        ebool resolverOk = IConditionResolver(e.resolver).canRedeem(id);
        FHE.allowThis(resolverOk);

        // AND all three conditions.
        ebool c1 = FHE.and(ownerOk, notRedeemed);
        FHE.allowThis(c1);
        canRedeem = FHE.and(c1, resolverOk);
        FHE.allowThis(canRedeem);

        // Payout = canRedeem ? paidAmount : 0. Handle uninitialized paidAmount
        // by substituting a trivial encrypted zero so FHE.select runs safely.
        euint64 zero64 = FHE.asEuint64(uint256(0));
        FHE.allowThis(zero64);
        euint64 funded = Common.isInitialized(e.paidAmount) ? e.paidAmount : zero64;
        payout = FHE.select(canRedeem, funded, zero64);
        FHE.allowThis(payout);
    }

    /// @dev Flip isRedeemed to true only when canRedeem is encrypted-true.
    ///      Uses FHE.select so the write happens unconditionally (side-channel safe).
    function _markRedeemed(uint256 id, ebool canRedeem) internal {
        Escrow storage e = _escrows[id];
        ebool prior;
        if (Common.isInitialized(e.isRedeemed)) {
            prior = e.isRedeemed;
        } else {
            prior = FHE.asEbool(false);
            FHE.allowThis(prior);
        }
        ebool trueE = FHE.asEbool(true);
        FHE.allowThis(trueE);
        e.isRedeemed = FHE.select(canRedeem, trueE, prior);
        FHE.allowThis(e.isRedeemed);
    }

    /// @dev Transfer encrypted PUSDC to `to`. Uses the uint256-selector low-level
    ///      call for compatibility with the deployed pre-v0.1.0 ConfidentialUSDC.
    ///      See YieldDistributor:94 and PUSDC_TRANSFER_ISSUE.md for context.
    function _pay(address to, euint64 amount) internal {
        // Grant PUSDC ACL access to the handle so it can run its internal
        // FHE.sub/add in _doTransfer. Mirrors YieldDistributor's pattern.
        FHE.allow(amount, paymentToken);

        (bool ok, ) = paymentToken.call(
            abi.encodeWithSelector(
                _TRANSFER_UINT256,
                to,
                uint256(euint64.unwrap(amount))
            )
        );
        if (!ok) revert PaymentTransferFailed();
    }

    // ── Views ─────────────────────────────────────────────────────────────

    /// @inheritdoc IMuHavenEscrow
    function exists(uint256 escrowId) external view returns (bool) {
        return _escrows[escrowId].exists;
    }

    /// @inheritdoc IMuHavenEscrow
    function getOwner(uint256 escrowId) external view returns (eaddress) {
        return _escrows[escrowId].owner;
    }

    /// @inheritdoc IMuHavenEscrow
    function getPaidAmount(uint256 escrowId) external view returns (euint64) {
        return _escrows[escrowId].paidAmount;
    }

    /// @inheritdoc IMuHavenEscrow
    function getIsRedeemed(uint256 escrowId) external view returns (ebool) {
        return _escrows[escrowId].isRedeemed;
    }

    /// @inheritdoc IMuHavenEscrow
    function getResolver(uint256 escrowId) external view returns (address) {
        return _escrows[escrowId].resolver;
    }

    /// @inheritdoc IMuHavenEscrow
    function total() external view returns (uint256) {
        return escrowCount;
    }

    // ── Admin ─────────────────────────────────────────────────────────────

    function setAuthorizedCaller(address caller, bool authorized) external onlyContractOwner {
        if (caller == address(0)) revert ZeroAddress();
        authorizedCallers[caller] = authorized;
        emit AuthorizedCallerUpdated(caller, authorized);
    }

    function setPaymentToken(address newToken) external onlyContractOwner {
        if (newToken == address(0)) revert ZeroAddress();
        paymentToken = newToken;
        emit PaymentTokenUpdated(newToken);
    }

    function transferOwnership(address newOwner) external onlyContractOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = contractOwner;
        contractOwner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    // ── EIP-165 ─────────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override
        returns (bool)
    {
        return interfaceId == type(IMuHavenEscrow).interfaceId
            || super.supportsInterface(interfaceId);
    }
}
