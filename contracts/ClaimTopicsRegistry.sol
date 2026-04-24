// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IClaimTopicsRegistry} from "./interfaces/IClaimTopicsRegistry.sol";

/// @title ClaimTopicsRegistry
/// @notice Minimal ERC-3643 claim-topic registry consumed by
///         `MuHavenIdentityRegistry.isVerified` in production mode.
///         Deployed behind an OZ Transparent Proxy.
///
/// @dev Wave 3.5 ships this alongside the identity registry (ADR-011). In
///      dev-mode nothing here matters — `isVerified` returns true without
///      consulting the required-topic set. Once dev-mode is permanently
///      disabled (`disableDevModeForever`), the identity registry iterates
///      this contract's topics on every `isVerified` call and demands a
///      matching valid claim per topic.
contract ClaimTopicsRegistry is Initializable, IClaimTopicsRegistry {

    // ── Storage ──────────────────────────────────────────────────────────

    address public owner;

    uint256[] private _topics;
    /// @dev 1-based index into `_topics`; 0 means "not present" (swap-and-pop).
    mapping(uint256 topic => uint256 oneBasedIndex) private _indexOf;

    uint256[48] private __gap;

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _owner) external initializer {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
    }

    // ── Admin ────────────────────────────────────────────────────────────

    function addClaimTopic(uint256 topic) external onlyOwner {
        if (_indexOf[topic] != 0) revert TopicAlreadyRequired();
        _topics.push(topic);
        _indexOf[topic] = _topics.length; // 1-based
        emit ClaimTopicAdded(topic);
    }

    function removeClaimTopic(uint256 topic) external onlyOwner {
        uint256 oneBased = _indexOf[topic];
        if (oneBased == 0) revert TopicNotRequired();

        uint256 lastIndex = _topics.length - 1;
        uint256 removeIndex = oneBased - 1;

        if (removeIndex != lastIndex) {
            uint256 lastTopic = _topics[lastIndex];
            _topics[removeIndex] = lastTopic;
            _indexOf[lastTopic] = oneBased; // same 1-based slot
        }

        _topics.pop();
        delete _indexOf[topic];

        emit ClaimTopicRemoved(topic);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    // ── Views ────────────────────────────────────────────────────────────

    function getClaimTopics() external view returns (uint256[] memory) {
        return _topics;
    }

    function claimTopicCount() external view returns (uint256) {
        return _topics.length;
    }

    function isRequired(uint256 topic) external view returns (bool) {
        return _indexOf[topic] != 0;
    }
}
