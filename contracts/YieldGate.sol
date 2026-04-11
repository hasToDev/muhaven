// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Common, euint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IMuHavenToken} from "./interfaces/IMuHavenToken.sol";
import {IKYCGate} from "./interfaces/IKYCGate.sol";

/// @title YieldGate
/// @notice ReineiraOS gate plugin for conditional yield settlement.
///         An escrow is only settled when both conditions pass:
///           1. Beneficiary is KYC-eligible
///           2. Beneficiary holds an encrypted token balance (is a token holder)
///
///         NOT proxied — follows the swap pattern. To upgrade: deploy a new
///         YieldGate and call YieldDistributor.setYieldGate(newAddress).
///
///         Hackathon simplification: condition 2 uses Common.isInitialized()
///         as a proxy for "has a balance". In production, this should use
///         async decryption to verify balance > 0 (FHE.gt cannot be read
///         synchronously as a plain bool).
contract YieldGate is ERC165 {

    // ── Storage ───────────────────────────────────────────────────────────

    IMuHavenToken public immutable muhavenToken;
    IKYCGate public immutable kycGate;

    /// @dev Maps ReineiraOS escrow ID → beneficiary address.
    ///      Set via onConditionSet() when the escrow is created.
    mapping(uint256 => address) public escrowBeneficiary;

    // ── Events ────────────────────────────────────────────────────────────

    event ConditionSet(uint256 indexed escrowId, address indexed beneficiary);

    // ── Errors ────────────────────────────────────────────────────────────

    error ZeroAddress();
    error UnknownEscrow();

    // ── Constructor ───────────────────────────────────────────────────────

    constructor(address _muhavenToken, address _kycGate) {
        if (_muhavenToken == address(0) || _kycGate == address(0)) revert ZeroAddress();
        muhavenToken = IMuHavenToken(_muhavenToken);
        kycGate = IKYCGate(_kycGate);
    }

    // ── ReineiraOS gate interface ─────────────────────────────────────────

    /// @notice Called by ReineiraOS when an escrow is created with this gate.
    ///         Decodes the beneficiary address from the condition data payload
    ///         and stores it for use in isConditionMet().
    ///
    /// @param escrowId  The ReineiraOS escrow ID
    /// @param data      ABI-encoded beneficiary address: abi.encode(address)
    function onConditionSet(uint256 escrowId, bytes calldata data) external {
        address beneficiary = abi.decode(data, (address));
        if (beneficiary == address(0)) revert ZeroAddress();
        escrowBeneficiary[escrowId] = beneficiary;
        emit ConditionSet(escrowId, beneficiary);
    }

    /// @notice Evaluated by ReineiraOS before releasing an escrow.
    ///         Returns true only when both checks pass.
    ///
    ///         Check 1 — KYC eligibility: beneficiary is whitelisted.
    ///         Check 2 — Token holder: beneficiary's encrypted balance ciphertext
    ///                   is initialized (i.e. they have ever received tokens).
    ///
    ///         Production upgrade path:
    ///           Replace check 2 with FHE.gt(balance, FHE.asEuint128(0)) + async
    ///           decrypt to get a definitive balance > 0 result. Common.isInitialized
    ///           is a sufficient proxy for the hackathon mock because tokens are only
    ///           minted to investors who passed KYC, so an initialized balance
    ///           means they currently hold or once held tokens.
    ///
    /// @param escrowId  The ReineiraOS escrow ID to evaluate
    /// @return true if both KYC and token-holder conditions are met
    function isConditionMet(uint256 escrowId) external view returns (bool) {
        address beneficiary = escrowBeneficiary[escrowId];
        if (beneficiary == address(0)) revert UnknownEscrow();

        // Check 1: KYC gate
        if (!kycGate.isEligible(beneficiary)) return false;

        // Check 2: Token holder (hackathon proxy — see Production upgrade path above)
        euint128 encBalance = muhavenToken.encryptedBalanceOf(beneficiary);
        if (!Common.isInitialized(encBalance)) return false;

        return true;
    }

    // ── EIP-165 ─────────────────────────────────────────────────────────

    /// @dev IConditionResolver interfaceId = isConditionMet(uint256) ^ onConditionSet(uint256,bytes)
    bytes4 private constant _ICONDITION_RESOLVER_ID =
        bytes4(keccak256("isConditionMet(uint256)")) ^
        bytes4(keccak256("onConditionSet(uint256,bytes)"));

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override
        returns (bool)
    {
        return interfaceId == _ICONDITION_RESOLVER_ID
            || super.supportsInterface(interfaceId);
    }
}
