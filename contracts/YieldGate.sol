// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, ebool, euint128, Common} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IMuHavenToken} from "./interfaces/IMuHavenToken.sol";
import {IKYCGate} from "./interfaces/IKYCGate.sol";
import {IConditionResolver} from "./interfaces/IConditionResolver.sol";

/// @title YieldGate
/// @notice Condition resolver plugin for MuHavenEscrow. An escrow is only
///         settleable when both checks pass:
///           1. Beneficiary is KYC-eligible
///           2. Beneficiary holds an encrypted token balance (is a token holder)
///
///         NOT proxied — follows the swap pattern. To upgrade: deploy a new
///         YieldGate and call MuHavenEscrow owners to migrate via the SDK.
///
///         `canRedeem` returns an `ebool` that MuHavenEscrow folds into its
///         silent-failure AND chain. Both checks resolve to plaintext booleans
///         (KYC whitelist + balance initialization are cleartext state); we
///         trivially encrypt the result so the escrow can operate on it via FHE.
///
///         Hackathon simplification: condition 2 uses `Common.isInitialized()`
///         as a proxy for "has a balance". Production would use `FHE.gt(balance, 0)`
///         via an async decrypt — see the production upgrade path below.
///
/// @dev Privacy caveat:
///      The beneficiary address is stored in plaintext (`_escrowBeneficiary`)
///      because the KYC check is plaintext. The mapping is `private` and
///      no public getter is exposed, but storage slots are still readable
///      off-chain via RPC `eth_getStorageAt`. This is an acknowledged residual
///      leak of the eaddress-owner privacy goal — fully closing it requires
///      an FHE-based KYC gate. See THREAT_MODEL.md.
contract YieldGate is IConditionResolver, ERC165 {

    // ── Storage ───────────────────────────────────────────────────────────

    IMuHavenToken public immutable muhavenToken;
    IKYCGate public immutable kycGate;

    /// @dev Admin / swap authority. Can rotate the authorized escrow.
    address public owner;

    /// @dev Only this address may call `onConditionSet`. Prevents arbitrary
    ///      callers from hijacking the beneficiary mapping.
    address public authorizedEscrow;

    /// @dev Private — plaintext beneficiary cache used by canRedeem().
    ///      See privacy caveat in the contract docstring.
    mapping(uint256 => address) private _escrowBeneficiary;

    // ── Events ────────────────────────────────────────────────────────────

    /// @dev `beneficiary` is NOT emitted to avoid placing an escrowId ↔ investor
    ///      link in event logs (which are cheap to index off-chain).
    event ConditionSet(uint256 indexed escrowId);
    event AuthorizedEscrowUpdated(address indexed newEscrow);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ────────────────────────────────────────────────────────────

    error ZeroAddress();
    error Unauthorized();
    error UnknownEscrow();
    error AlreadySet();
    error AuthorizedEscrowNotSet();

    // ── Modifiers ─────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────

    /// @param _muhavenToken  Address of the RWA token whose holders are gated.
    /// @param _kycGate       KYC/whitelist oracle.
    ///
    /// @dev `authorizedEscrow` is intentionally deferred to a setter so deploy
    ///      scripts can ship this contract before MuHavenEscrow is live. The
    ///      resolver is unusable until `setAuthorizedEscrow` is called.
    constructor(address _muhavenToken, address _kycGate) {
        if (_muhavenToken == address(0) || _kycGate == address(0)) revert ZeroAddress();
        muhavenToken = IMuHavenToken(_muhavenToken);
        kycGate = IKYCGate(_kycGate);
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ── IConditionResolver ────────────────────────────────────────────────

    /// @inheritdoc IConditionResolver
    ///
    /// @dev Called by MuHavenEscrow.batchCreate() once per escrow.
    ///      Decodes the beneficiary address from the resolver data payload
    ///      and stores it for use in canRedeem().
    ///      `data` format: `abi.encode(address beneficiary)`.
    function onConditionSet(uint256 escrowId, bytes calldata data) external {
        if (authorizedEscrow == address(0)) revert AuthorizedEscrowNotSet();
        if (msg.sender != authorizedEscrow) revert Unauthorized();
        if (_escrowBeneficiary[escrowId] != address(0)) revert AlreadySet();

        address beneficiary = abi.decode(data, (address));
        if (beneficiary == address(0)) revert ZeroAddress();

        _escrowBeneficiary[escrowId] = beneficiary;
        emit ConditionSet(escrowId);
    }

    /// @inheritdoc IConditionResolver
    ///
    /// @dev Evaluates two cleartext checks and trivially encrypts the AND.
    ///      The result is granted to `msg.sender` (MuHavenEscrow) so it can
    ///      fold the ebool into its silent-failure chain.
    ///
    ///      Production upgrade path:
    ///        Replace check 2 with `FHE.gt(balance, FHE.asEuint128(0))` +
    ///        async decrypt for a definitive balance > 0 verdict.
    ///        `Common.isInitialized` is a sufficient proxy for the hackathon
    ///        because tokens are only minted to KYC-verified investors.
    function canRedeem(uint256 escrowId) external returns (ebool allowed) {
        address beneficiary = _escrowBeneficiary[escrowId];
        if (beneficiary == address(0)) revert UnknownEscrow();

        bool kycOk = kycGate.isEligible(beneficiary);
        euint128 encBalance = muhavenToken.encryptedBalanceOf(beneficiary);
        bool hasBalance = Common.isInitialized(encBalance);

        allowed = FHE.asEbool(kycOk && hasBalance);
        FHE.allowThis(allowed);
        FHE.allow(allowed, msg.sender);
    }

    // ── Admin ─────────────────────────────────────────────────────────────

    /// @notice Set (or rotate) the address allowed to call onConditionSet.
    ///         Only affects future escrows — existing mappings are preserved.
    function setAuthorizedEscrow(address newEscrow) external onlyOwner {
        if (newEscrow == address(0)) revert ZeroAddress();
        authorizedEscrow = newEscrow;
        emit AuthorizedEscrowUpdated(newEscrow);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    // ── EIP-165 ─────────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override
        returns (bool)
    {
        return interfaceId == type(IConditionResolver).interfaceId
            || super.supportsInterface(interfaceId);
    }
}
