// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IClaimTopicsRegistry
/// @notice ERC-3643-shaped registry of claim topics that a verified identity
///         must hold in order to pass `IdentityRegistry.isVerified` in
///         production mode.
///
/// @dev Wave 3.5 ships a minimal implementation alongside
///      `MuHavenIdentityRegistry` so the dev-mode → production flip is a
///      configuration change, not a contract redeploy (ADR-011 / ADR-023).
///      Topic IDs follow ERC-735 conventions (e.g. `1 = KYC`, `2 = AML`,
///      `7 = ACCREDITED`). Topic semantics are not enforced here — the
///      registry only stores the required-topic set.
interface IClaimTopicsRegistry {
    // ── Events ────────────────────────────────────────────────────────────

    event ClaimTopicAdded(uint256 indexed topic);
    event ClaimTopicRemoved(uint256 indexed topic);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ────────────────────────────────────────────────────────────

    error OnlyOwner();
    error ZeroAddress();
    error TopicAlreadyRequired();
    error TopicNotRequired();

    // ── Admin ─────────────────────────────────────────────────────────────

    /// @notice Mark `topic` as required. Reverts if already required.
    function addClaimTopic(uint256 topic) external;

    /// @notice Remove `topic` from the required set.
    function removeClaimTopic(uint256 topic) external;

    // ── Views ─────────────────────────────────────────────────────────────

    /// @notice Full list of required topic IDs.
    function getClaimTopics() external view returns (uint256[] memory);

    /// @notice Count of required topics.
    function claimTopicCount() external view returns (uint256);

    /// @notice Whether `topic` is in the required set.
    function isRequired(uint256 topic) external view returns (bool);
}
