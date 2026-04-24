// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ITrustedIssuersRegistry
/// @notice ERC-3643-shaped registry of claim issuers that the
///         `IdentityRegistry` trusts to attest claim topics on investor
///         identities.
///
/// @dev Wave 3.5 ships a minimal implementation. A trusted issuer is bound to
///      the **set of topics it is authorised to sign** — an issuer authorised
///      for topic `1` (KYC) may not be authorised for topic `7` (accredited).
///      `hasClaimTopic` is the hot-path check `IdentityRegistry.isVerified`
///      consults to decide whether a stored claim is admissible.
interface ITrustedIssuersRegistry {
    // ── Events ────────────────────────────────────────────────────────────

    event TrustedIssuerAdded(address indexed issuer, uint256[] topics);
    event TrustedIssuerRemoved(address indexed issuer);
    event IssuerTopicsUpdated(address indexed issuer, uint256[] topics);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ────────────────────────────────────────────────────────────

    error OnlyOwner();
    error ZeroAddress();
    error EmptyTopicList();
    error IssuerAlreadyTrusted();
    error IssuerNotTrusted();

    // ── Admin ─────────────────────────────────────────────────────────────

    /// @notice Add `issuer` as trusted for the given `topics`.
    function addTrustedIssuer(address issuer, uint256[] calldata topics) external;

    /// @notice Remove `issuer` from the trusted set entirely.
    function removeTrustedIssuer(address issuer) external;

    /// @notice Replace the topic set authorised for a trusted `issuer`.
    function updateIssuerTopics(address issuer, uint256[] calldata topics) external;

    // ── Views ─────────────────────────────────────────────────────────────

    /// @notice Whether `issuer` is trusted to sign any topics.
    function isTrustedIssuer(address issuer) external view returns (bool);

    /// @notice Whether `issuer` is trusted to sign `topic`.
    function hasClaimTopic(address issuer, uint256 topic) external view returns (bool);

    /// @notice Topics `issuer` is authorised to sign.
    function getIssuerTopics(address issuer) external view returns (uint256[] memory);

    /// @notice Trusted issuers authorised to sign `topic`.
    function getTrustedIssuersForClaimTopic(uint256 topic) external view returns (address[] memory);
}
